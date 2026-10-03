/**
 * 物料定义、确认入库批次与追加式库存流水的语义锁。
 *
 *   1. 状态由确定性追加流水派生，自由状态字典已退役。
 *   4. 责任方复用 task 的主体抽象：部门 | 用户组，二选一，DB CHECK 兜底
 *   5. 改责任方时每个字段只清自己那一支（同 task 那个数据丢失的修法）
 *   6. 编号在剧组内唯一，跨剧组不管
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { PATCH as patchMaterial } from "@/app/api/production/[id]/materials/[materialId]/route";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { createEventGroup } from "@/lib/ops/event-group-db";
import { resolveSubjectPatch } from "@/lib/ops/task-poc";
import { canCreateMaterial, canWriteMaterial } from "@/lib/ops/material-perm";
import {
  appendMaterialStockMovement, createMaterialStockLot,
  createMaterial, deleteMaterial,
  getMaterial, listMaterials, listMaterialStockLots,
  listMaterialStockMovements, MaterialError, updateMaterial,
} from "@/lib/ops/material-db";

let prodId: string, otherProdId: string;
let ownerId: string, deptId: string, groupId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `物料主${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  ({ prodId: otherProdId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `道具${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,true)`,
    [prodId, deptId, ownerId],
  );
  groupId = (await createEventGroup({
    productionId: prodId, eventId: null, name: `道具组${shortId()}`,
    members: [{ kind: "dept", id: deptId }], poc: { kind: "dept", id: deptId },
    createdBy: ownerId,
  })).id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});


describe("4. 责任方：部门 | 用户组，二选一", () => {
  it("两种都存得住，且带出名称", async () => {
    const byDept = await createMaterial({
      productionId: prodId, name: "归部门的",
      subject: { kind: "dept", id: deptId }, createdBy: ownerId,
    });
    expect(byDept.departmentId).toBe(deptId);
    expect(byDept.departmentName).toBeTruthy();
    expect(byDept.groupId).toBeNull();

    const byGroup = await createMaterial({
      productionId: prodId, name: "归组的",
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    expect(byGroup.groupId).toBe(groupId);
    expect(byGroup.groupName).toBeTruthy();
    expect(byGroup.departmentId).toBeNull();
  });

  it("DB CHECK 挡住同时给两个", async () => {
    await expect(getPool().query(
      `INSERT INTO production_material
         (id, production_id, name, department_id, group_id, created_by)
       VALUES ($1,$2,'两个责任方',$3,$4,$5)`,
      [`mt_${shortId()}`, prodId, deptId, groupId, ownerId],
    )).rejects.toThrow(/material_owner_single/);
  });
});

describe("5. 改责任方时每个字段只清自己那一支", () => {
  it("绑组的物料收到 departmentId:null，组绑定必须保留", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "组负责的道具",
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    // 只知道部门的旧客户端会这么发——不能让它的沉默变成删除（同 task 那个坑）
    const patch = await resolveSubjectPatch(prodId, { departmentId: null }, m);
    expect(patch.ok).toBe(true);
    if (patch.ok) await updateMaterial(m.id, prodId, { subjectCols: patch.cols });

    const after = await getMaterial(m.id, prodId);
    expect(after!.groupId).toBe(groupId);
  });

  it("显式发 groupId:null 才解绑", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "要解绑的",
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    const patch = await resolveSubjectPatch(prodId, { groupId: null }, m);
    if (patch.ok) await updateMaterial(m.id, prodId, { subjectCols: patch.cols });
    expect((await getMaterial(m.id, prodId))!.groupId).toBeNull();
  });
});

describe("6. 编号由服务端按项目分配", () => {
  it("同项目连续生成且不可由编辑接口改写；其他项目使用自己的序列", async () => {
    const first = await createMaterial({
      productionId: prodId, name: "第一种", subject: null, createdBy: ownerId,
    });
    const second = await createMaterial({
      productionId: prodId, name: "第二种", subject: null, createdBy: ownerId,
    });
    const other = await createMaterial({
      productionId: otherProdId, name: "别的项目", subject: null, createdBy: ownerId,
    });
    expect(first.number).toMatch(/^M-\d{4,}-\d$/);
    expect(second.number).not.toBe(first.number);
    expect(other.number).toBe("M-0001-7");
    expect(await updateMaterial(second.id, prodId, { name: "只改名称" }))
      .toMatchObject({ number: second.number });
  });
});

describe("列表与删除", () => {
  it("只列本剧组的；已有库存历史后不能硬删", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "待删", subject: null, createdBy: ownerId,
    });
    expect((await listMaterials(prodId)).some(x => x.id === m.id)).toBe(true);
    expect((await listMaterials(otherProdId)).some(x => x.id === m.id)).toBe(false);

    await expect(deleteMaterial(m.id, prodId)).rejects.toMatchObject({ reason: "has_history" });
    expect(await getMaterial(m.id, prodId)).not.toBeNull();
  });
});

describe("7. 确认入库批次与追加式流水", () => {
  it("同一物料可同时有待到货、在库、签出和维护数量，且查询口径明确", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "无线话筒",
      subject: null, location: "设备库", quantity: 10, createdBy: ownerId,
    });
    const [receivedLot] = await listMaterialStockLots(m.id, prodId);
    await appendMaterialStockMovement({
      productionId: prodId, lotId: receivedLot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 4, createdBy: ownerId,
    });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: receivedLot.id, fromBucket: "in_stock",
      toBucket: "maintenance", quantity: 2, reason: "送修", createdBy: ownerId,
    });
    await createMaterialStockLot({
      productionId: prodId, materialId: m.id, confirmedQuantity: 3,
      location: "供应商待发", createdBy: ownerId,
    });

    const current = await getMaterial(m.id, prodId);
    expect(current).toMatchObject({
      expectedQuantity: 3,
      inStockQuantity: 4,
      availableQuantity: 4,
      checkedOutQuantity: 4,
      maintenanceQuantity: 2,
      heldQuantity: 10,
      exitedQuantity: 0,
    });
  });

  it("签出默认仍占用数量；返还流水只减少对应签出量", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "黑色胶带",
      subject: null, quantity: 5, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(m.id, prodId);
    const checkout = await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 5, note: "演出签出", createdBy: ownerId,
    });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "checked_out",
      toBucket: "in_stock", quantity: 3, returnOfMovementId: checkout.id,
      note: "返还三卷", createdBy: ownerId,
    });
    expect(await getMaterial(m.id, prodId)).toMatchObject({
      inStockQuantity: 3, checkedOutQuantity: 2, heldQuantity: 5,
    });
    expect((await listMaterialStockMovements(lot.id, prodId)).map(x => x.id))
      .toContain(checkout.id);
  });

  it("拒绝负库存，且并发扣减不会丢失更新", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "并发测试设备",
      subject: null, quantity: 5, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(m.id, prodId);
    const move = () => appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 4, createdBy: ownerId,
    });
    const results = await Promise.allSettled([move(), move()]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
    expect(await getMaterial(m.id, prodId)).toMatchObject({
      inStockQuantity: 1, checkedOutQuantity: 4,
    });
  });

  it("流水不可 UPDATE/DELETE；错误通过一条精确反向流水冲销", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "冲销测试",
      subject: null, quantity: 2, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(m.id, prodId);
    const wrong = await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "maintenance", quantity: 1, reason: "送修", createdBy: ownerId,
    });
    await expect(getPool().query(
      "UPDATE production_material_stock_movement SET note='篡改' WHERE id=$1", [wrong.id],
    )).rejects.toThrow(/append-only/);
    await expect(getPool().query(
      "DELETE FROM production_material_stock_movement WHERE id=$1", [wrong.id],
    )).rejects.toThrow(/append-only/);
    await expect(appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "maintenance",
      toBucket: "in_stock", quantity: 1, reversesEventId:
        (await listMaterialStockMovements(lot.id, prodId))[0].id,
      reason: "纠错", createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_reversal" });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "maintenance",
      toBucket: "in_stock", quantity: 1, reversesEventId: wrong.id,
      reason: "冲销误操作", createdBy: ownerId,
    });
    expect(await getMaterial(m.id, prodId)).toMatchObject({
      inStockQuantity: 2, maintenanceQuantity: 0,
    });

    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "maintenance", quantity: 1, reason: "送修", createdBy: ownerId,
    });
    await expect(appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "maintenance",
      toBucket: "in_stock", quantity: 1, reversesEventId: wrong.id,
      reason: "纠错", createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_reversal" });
  });

  it("定义更新不能绕过流水覆盖数量或库位", async () => {
    const m = await createMaterial({
      productionId: prodId, name: "禁止覆盖写",
      subject: null, quantity: 2, createdBy: ownerId,
    });
    await expect(updateMaterial(m.id, prodId, { quantity: 9 }))
      .rejects.toMatchObject({ reason: "inventory_requires_movement" });
    await expect(updateMaterial(m.id, prodId, { location: "未知新库位" }))
      .rejects.toMatchObject({ reason: "inventory_requires_movement" });
  });
});

describe("8. PATCH 的名字校验与 POST 对称", () => {
  // 与财务预算科目同一处毛病、同一处修法：db 层 trim 之后空串照落，
  // 拦截点只能在路由。见 tests/finance.test.ts 的同名 describe。
  function req(userId: string, body: unknown) {
    const r = new NextRequest("http://localhost/api/x", {
      method: "PATCH", body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    r.cookies.set(SESSION_COOKIE, createSession({
      userId, name: "测试", avatarUrl: null, isAdmin: false,
    }));
    return r;
  }

  it("name 为空串 / 纯空白都被拒，且物料名不变", async () => {
    const m = await createMaterial({
      productionId: prodId, name: `改名物料${shortId()}`,
      subject: null, createdBy: ownerId,
    });
    const ctx = () => ({ params: Promise.resolve({ id: prodId, materialId: m.id }) });

    for (const bad of ["", "   "]) {
      const res = await patchMaterial(req(ownerId, { name: bad }), ctx());
      expect(res.status).toBe(400);
    }
    expect((await getMaterial(m.id, prodId))?.name).toBe(m.name);
  });

  it("正常改名仍然通得过", async () => {
    const m = await createMaterial({
      productionId: prodId, name: `原名${shortId()}`,
      subject: null, createdBy: ownerId,
    });
    const ctx = () => ({ params: Promise.resolve({ id: prodId, materialId: m.id }) });
    const newName = `新名${shortId()}`;
    const res = await patchMaterial(req(ownerId, { name: newName }), ctx());
    expect(res.status).toBe(200);
    expect((await getMaterial(m.id, prodId))?.name).toBe(newName);
  });
});

/**
 * 责任方 POC 的上下文判定。
 *
 * 中心命题：**各部门自管自的剧组，一个权限键都不用发。**
 * 注意所有用例都用非 owner 的人——owner 在 hasEffectiveGrant 里直接旁路，
 * 拿他测等于什么都没测（这个坑记在 feedback_owner_bypass）。
 */
describe("9. 责任方的 POC 管自己那一摊", () => {
  let deptB: string, pocA: string, pocB: string, stranger: string;
  const actor = (userId: string) => ({ userId, isAdmin: false, isOwner: false });

  beforeAll(async () => {
    ({ rows: [{ id: deptB }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
      [prodId, `服装${shortId()}`],
    ));
    for (const [tag, dept] of [["pocA", deptId], ["pocB", deptB]] as const) {
      const u = (await upsertFeishuUser(`test-open-${shortId()}`, `${tag}${shortId()}`, null, false)).userId;
      await addProductionMember(prodId, u);
      await getPool().query(
        `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,true)`,
        [prodId, dept, u],
      );
      if (tag === "pocA") pocA = u; else pocB = u;
    }
    stranger = (await upsertFeishuUser(`test-open-${shortId()}`, `路人${shortId()}`, null, false)).userId;
    await addProductionMember(prodId, stranger);
  });

  it("挂在 A 部门的物料：A 的 POC 能改能删，B 的 POC 和路人都不能", async () => {
    const m = await createMaterial({
      productionId: prodId, name: `A 部门的箱子${shortId()}`,
      subject: { kind: "dept", id: deptId }, createdBy: ownerId,
    });
    for (const verb of ["edit", "delete"] as const) {
      expect(await canWriteMaterial(actor(pocA), prodId, m, verb)).toBe(true);
      expect(await canWriteMaterial(actor(pocB), prodId, m, verb)).toBe(false);
      expect(await canWriteMaterial(actor(stranger), prodId, m, verb)).toBe(false);
    }
  });

  it("用户组做责任方时同样成立（组 POC ≠ 部门 POC，走的是同一个 isSubjectPoc）", async () => {
    const m = await createMaterial({
      productionId: prodId, name: `组的物料${shortId()}`,
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    // groupId 的 POC 是 deptId 这个部门 → 该部门的 POC 都算
    expect(await canWriteMaterial(actor(pocA), prodId, m, "edit")).toBe(true);
    expect(await canWriteMaterial(actor(pocB), prodId, m, "edit")).toBe(false);
  });

  it("无责任方的物料谁都改不了——它属于台账公共部分，只有域级键能动", async () => {
    const m = await createMaterial({
      productionId: prodId, name: `无主物料${shortId()}`,
      subject: null, createdBy: ownerId,
    });
    expect(await canWriteMaterial(actor(pocA), prodId, m, "edit")).toBe(false);
    expect(await canWriteMaterial(actor(pocB), prodId, m, "edit")).toBe(false);
  });

  it("建物料：只能建到自己是 POC 的那一方名下，不能替别人建", async () => {
    expect(await canCreateMaterial(actor(pocA), prodId, { kind: "dept", id: deptId })).toBe(true);
    expect(await canCreateMaterial(actor(pocA), prodId, { kind: "dept", id: deptB })).toBe(false);
    // 无责任方 = 公共部分，POC 身份不够
    expect(await canCreateMaterial(actor(pocA), prodId, null)).toBe(false);
    expect(await canCreateMaterial(actor(stranger), prodId, { kind: "dept", id: deptId })).toBe(false);
  });

  it("owner 依然畅通（旁路在 hasEffectiveGrant 里，不该被这条判定挡住）", async () => {
    const m = await createMaterial({
      productionId: prodId, name: `owner 测${shortId()}`,
      subject: { kind: "dept", id: deptB }, createdBy: ownerId,
    });
    expect(await canWriteMaterial(
      { userId: ownerId, isAdmin: false, isOwner: true }, prodId, m, "delete")).toBe(true);
  });
});

/**
 * 收敛棘轮：物料本身的三个写点（建 / 改 / 删）一律走 lib/ops/material-perm，
 * 不许各写各的 hasEffectiveGrant。
 *
 * 状态表的 CRUD 不在此列——状态没有「责任方」，它是剧组级的一张小字典，
 * 只是碰巧共用 material 这个域键。故按**动词**筛，且放过 statuses/ 那一支。
 */
describe("10. 判定收敛", () => {
  it("物料写点不直接对 material 域调 hasEffectiveGrant", async () => {
    const { readFileSync, readdirSync } = await import("fs");
    const { join } = await import("path");
    const base = "app/api/production/[id]/materials";
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "route.ts") files.push(full);
      }
    };
    walk(base);
    // [^;]* 而不是 [^)]*——参数里就有括号（toActor(session, ...)），按 ) 断会在走到
    // "material" 之前就停下，棘轮永远绿。按语句边界断才拦得住。（验红过。）
    const offenders = files
      .filter(f => !f.includes("statuses"))
      .filter(f => /hasEffectiveGrant\([^;]*"material"[^;]*"(create|edit|delete)"/.test(
        readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
