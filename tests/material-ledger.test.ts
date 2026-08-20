/**
 * 物料台账的语义锁。
 *
 *   1. 状态是**列表不是状态机**：任何状态可改到任何状态，不校验流转
 *   2. 状态列表 = 系统预设 ∪ 本剧组自定义；系统预设删不掉；跨剧组的自定义状态不能用
 *   3. 删状态不连坐删物料（ON DELETE SET NULL）
 *   4. 责任方复用 task 的主体抽象：部门 | 用户组，二选一，DB CHECK 兜底
 *   5. 改责任方时每个字段只清自己那一支（同 task 那个数据丢失的修法）
 *   6. 编号在剧组内唯一，跨剧组不管
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { PATCH as patchMaterial } from "@/app/api/production/[id]/materials/[materialId]/route";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createEventGroup } from "@/lib/event-group-db";
import { resolveSubjectPatch } from "@/lib/task-poc";
import { canCreateMaterial, canWriteMaterial } from "@/lib/material-perm";
import {
  createMaterial, createMaterialStatus, deleteMaterial, deleteMaterialStatus,
  getMaterial, listMaterials, listMaterialStatuses, MaterialError, updateMaterial,
} from "@/lib/material-db";

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

async function statusIdByName(name: string): Promise<string> {
  const s = (await listMaterialStatuses(prodId)).find(x => x.name === name);
  if (!s) throw new Error(`status not found: ${name}`);
  return s.id;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("1. 状态是列表不是状态机", () => {
  it("任何状态可以改到任何状态，包括「已报废」改回「已入库」", async () => {
    const m = await createMaterial({
      productionId: prodId, code: `PR-${shortId()}`, name: "旧式黄铜航海罗盘",
      category: "道具", subject: { kind: "dept", id: deptId },
      statusId: await statusIdByName("制作中"), location: "A-03", createdBy: ownerId,
    });

    // 制作中 → 已报废 → 已入库：现实里未必合理，但现在**不校验**，
    // 等真实用法跑出规则再加约束（反过来是破坏性的）
    for (const name of ["已报废", "已入库", "使用中"]) {
      const after = await updateMaterial(m.id, prodId, { statusId: await statusIdByName(name) });
      expect(after!.statusName).toBe(name);
    }
  });
});

describe("2. 状态列表：系统预设 ∪ 剧组自定义", () => {
  it("默认能看到 5 个系统预设", async () => {
    const list = await listMaterialStatuses(prodId);
    expect(list.filter(s => s.isSystem).map(s => s.name))
      .toEqual(["已入库", "制作中", "使用中", "待修整", "已报废"]);
  });

  it("剧组自定义只对本剧组可见", async () => {
    const custom = await createMaterialStatus(prodId, `送洗中${shortId()}`, "#888", 10);
    expect((await listMaterialStatuses(prodId)).some(s => s.id === custom.id)).toBe(true);
    expect((await listMaterialStatuses(otherProdId)).some(s => s.id === custom.id)).toBe(false);
  });

  it("系统预设删不掉", async () => {
    const sysId = await statusIdByName("已入库");
    await deleteMaterialStatus(sysId, prodId);          // production_id 对不上 → no-op
    expect((await listMaterialStatuses(prodId)).some(s => s.id === sysId)).toBe(true);
  });

  it("跨剧组的自定义状态用不了", async () => {
    const foreign = await createMaterialStatus(otherProdId, `外状态${shortId()}`, null, 1);
    await expect(createMaterial({
      productionId: prodId, code: `X-${shortId()}`, name: "越界",
      subject: null, statusId: foreign.id, createdBy: ownerId,
    })).rejects.toThrow(MaterialError);
  });
});

describe("3. 删状态不连坐删物料", () => {
  it("自定义状态被删后，引用它的物料还在，只是没了状态", async () => {
    const custom = await createMaterialStatus(prodId, `待返厂${shortId()}`, null, 11);
    const m = await createMaterial({
      productionId: prodId, code: `CS-${shortId()}`, name: "深蓝风衣",
      subject: null, statusId: custom.id, createdBy: ownerId,
    });
    expect((await getMaterial(m.id, prodId))!.statusId).toBe(custom.id);

    await deleteMaterialStatus(custom.id, prodId);
    const after = await getMaterial(m.id, prodId);
    expect(after).not.toBeNull();
    expect(after!.statusId).toBeNull();
    expect(after!.statusName).toBeNull();
  });
});

describe("4. 责任方：部门 | 用户组，二选一", () => {
  it("两种都存得住，且带出名称", async () => {
    const byDept = await createMaterial({
      productionId: prodId, code: `D-${shortId()}`, name: "归部门的",
      subject: { kind: "dept", id: deptId }, createdBy: ownerId,
    });
    expect(byDept.departmentId).toBe(deptId);
    expect(byDept.departmentName).toBeTruthy();
    expect(byDept.groupId).toBeNull();

    const byGroup = await createMaterial({
      productionId: prodId, code: `G-${shortId()}`, name: "归组的",
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    expect(byGroup.groupId).toBe(groupId);
    expect(byGroup.groupName).toBeTruthy();
    expect(byGroup.departmentId).toBeNull();
  });

  it("DB CHECK 挡住同时给两个", async () => {
    await expect(getPool().query(
      `INSERT INTO production_material (production_id, code, name, department_id, group_id, created_by)
       VALUES ($1,$2,'两个责任方',$3,$4,$5)`,
      [prodId, `B-${shortId()}`, deptId, groupId, ownerId],
    )).rejects.toThrow(/material_owner_single/);
  });
});

describe("5. 改责任方时每个字段只清自己那一支", () => {
  it("绑组的物料收到 departmentId:null，组绑定必须保留", async () => {
    const m = await createMaterial({
      productionId: prodId, code: `K-${shortId()}`, name: "组负责的道具",
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
      productionId: prodId, code: `K2-${shortId()}`, name: "要解绑的",
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    const patch = await resolveSubjectPatch(prodId, { groupId: null }, m);
    if (patch.ok) await updateMaterial(m.id, prodId, { subjectCols: patch.cols });
    expect((await getMaterial(m.id, prodId))!.groupId).toBeNull();
  });
});

describe("6. 编号在剧组内唯一", () => {
  it("同剧组重复编号被拒；跨剧组同编号可以", async () => {
    const code = `U-${shortId()}`;
    await createMaterial({ productionId: prodId, code, name: "第一个", subject: null, createdBy: ownerId });
    await expect(createMaterial({
      productionId: prodId, code, name: "重号", subject: null, createdBy: ownerId,
    })).rejects.toThrow(MaterialError);

    // 别的剧组用同一个编号没问题
    const other = await createMaterial({
      productionId: otherProdId, code, name: "别家的", subject: null, createdBy: ownerId,
    });
    expect(other.code).toBe(code);
  });

  it("改编号撞车同样被拒", async () => {
    const a = await createMaterial({ productionId: prodId, code: `A-${shortId()}`, name: "甲", subject: null, createdBy: ownerId });
    const b = await createMaterial({ productionId: prodId, code: `B-${shortId()}`, name: "乙", subject: null, createdBy: ownerId });
    await expect(updateMaterial(b.id, prodId, { code: a.code })).rejects.toThrow(MaterialError);
  });
});

describe("列表与删除", () => {
  it("只列本剧组的；删掉就没了", async () => {
    const m = await createMaterial({
      productionId: prodId, code: `Z-${shortId()}`, name: "待删", subject: null, createdBy: ownerId,
    });
    expect((await listMaterials(prodId)).some(x => x.id === m.id)).toBe(true);
    expect((await listMaterials(otherProdId)).some(x => x.id === m.id)).toBe(false);

    await deleteMaterial(m.id, prodId);
    expect(await getMaterial(m.id, prodId)).toBeNull();
  });
});

describe("7. PATCH 的名字校验与 POST 对称", () => {
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
      productionId: prodId, code: `M${shortId()}`, name: `改名物料${shortId()}`,
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
      productionId: prodId, code: `M${shortId()}`, name: `原名${shortId()}`,
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
describe("8. 责任方的 POC 管自己那一摊", () => {
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
      productionId: prodId, code: `M${shortId()}`, name: `A 部门的箱子${shortId()}`,
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
      productionId: prodId, code: `M${shortId()}`, name: `组的物料${shortId()}`,
      subject: { kind: "group", id: groupId }, createdBy: ownerId,
    });
    // groupId 的 POC 是 deptId 这个部门 → 该部门的 POC 都算
    expect(await canWriteMaterial(actor(pocA), prodId, m, "edit")).toBe(true);
    expect(await canWriteMaterial(actor(pocB), prodId, m, "edit")).toBe(false);
  });

  it("无责任方的物料谁都改不了——它属于台账公共部分，只有域级键能动", async () => {
    const m = await createMaterial({
      productionId: prodId, code: `M${shortId()}`, name: `无主物料${shortId()}`,
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
      productionId: prodId, code: `M${shortId()}`, name: `owner 测${shortId()}`,
      subject: { kind: "dept", id: deptB }, createdBy: ownerId,
    });
    expect(await canWriteMaterial(
      { userId: ownerId, isAdmin: false, isOwner: true }, prodId, m, "delete")).toBe(true);
  });
});

/**
 * 收敛棘轮：物料本身的三个写点（建 / 改 / 删）一律走 lib/material-perm，
 * 不许各写各的 hasEffectiveGrant。
 *
 * 状态表的 CRUD 不在此列——状态没有「责任方」，它是剧组级的一张小字典，
 * 只是碰巧共用 material 这个域键。故按**动词**筛，且放过 statuses/ 那一支。
 */
describe("9. 判定收敛", () => {
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
