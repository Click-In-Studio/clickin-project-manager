import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/production/[id]/materials/[materialId]/movements/route";
import { PATCH } from "@/app/api/production/[id]/materials/[materialId]/route";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { selfConfirmResourceGrant } from "@/lib/perm/resource-grant-db";
import { createMaterial, getMaterial, listMaterialStockLots, listMaterialStockMovements } from "@/lib/ops/material-db";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let prodId: string, ownerId: string, outsiderId: string, viewerId: string, creatorId: string;
let responsiblePocId: string, responsibleDeptId: string;
beforeAll(async () => {
  const user = async () => (await upsertFeishuUser(`test-open-${shortId()}`, "流转 API", null, false)).userId;
  [ownerId, outsiderId, viewerId, creatorId, responsiblePocId] = await Promise.all([
    user(), user(), user(), user(), user(),
  ]);
  ({ prodId } = await makeProduction(ownerId));
  for (const id of [ownerId, viewerId, creatorId, responsiblePocId]) await addProductionMember(prodId, id);
  const { rows } = await getPool().query<{ id: string }>(
    "INSERT INTO production_dept (production_id,name) VALUES ($1,$2) RETURNING id",
    [prodId, `流转责任方-${shortId()}`],
  );
  responsibleDeptId = rows[0].id;
  await getPool().query(
    `INSERT INTO production_dept_member (production_id,dept_id,user_id,is_poc)
     VALUES ($1,$2,$3,true)`,
    [prodId, responsibleDeptId, responsiblePocId],
  );
  await getPool().query("DELETE FROM production_member_grant WHERE production_id=$1 AND user_id=ANY($2::uuid[])", [prodId, [viewerId, creatorId]]);
  await selfConfirmResourceGrant(viewerId, prodId, "material", "*", "view");
  await selfConfirmResourceGrant(creatorId, prodId, "material", "*", "create");
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

function req(body: unknown, userId?: string, method = "POST") {
  const withIdempotency = method === "POST" && body && typeof body === "object" && !Array.isArray(body)
    ? { idempotencyKey: `test-${shortId()}-${Date.now()}`, ...body as Record<string, unknown> }
    : body;
  const request = new NextRequest("http://localhost/api/production/x/materials/x/movements", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(withIdempotency),
  });
  if (userId) request.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return request;
}
async function fixture(rented = false, responsible = false) {
  const material = await createMaterial({ productionId: prodId, name: "线缆",
    quantity: 5,
    subject: responsible ? { kind: "dept", id: responsibleDeptId } : null,
    createdBy: ownerId,
    ...(rented ? { sourceType: "rented" as const, sourceLabel: "设备仓", returnDueAt: new Date("2026-12-01T00:00:00Z") } : {}) });
  const [lot] = await listMaterialStockLots(material.id, prodId);
  const ctx = { params: Promise.resolve({ id: prodId, materialId: material.id }) };
  return { material, lot, ctx, body: { lotId: lot.id, fromBucket: "in_stock", toBucket: "checked_out", quantity: 2 } };
}

describe("物料流转 API", () => {
  it("未登录 401、非成员 403、仅查看/创建单枚键 403，均不写流水", async () => {
    const { lot, ctx, body } = await fixture();
    for (const [id, status] of [[undefined, 401], [outsiderId, 403], [viewerId, 403], [creatorId, 403]] as const)
      expect((await POST(req(body, id), ctx)).status).toBe(status);
    expect(await listMaterialStockMovements(lot.id, prodId)).toHaveLength(1);
  });

  it("非法状态、用途、缺原因和超过库存稳定 400，失败完全不留流水", async () => {
    const { lot, ctx, body } = await fixture();
    for (const change of [
      { toBucket: "expected" }, { toBucket: "in_stock" }, { quantity: 6 }, { eventId: "不存在" },
      { toBucket: "maintenance" }, { toBucket: "exited", exitReason: "随意状态", reason: "退出" },
      { reversesEventId: "x", returnOfMovementId: "y" }, { quantity: "2" },
      { occurredAt: { toString: "bad" } }, { custodian: { kind: { toString: "bad" }, id: "x" } },
    ]) expect((await POST(req({ ...body, ...change }, ownerId), ctx)).status).toBe(400);
    expect(await listMaterialStockMovements(lot.id, prodId)).toHaveLength(1);
  });

  it("有效签出和部分返还 201；操作者由会话确定", async () => {
    const { material, lot, ctx, body } = await fixture();
    const response = await POST(req({ ...body, createdBy: outsiderId, custodianLabel: "演出现场" }, ownerId), ctx);
    expect(response.status).toBe(201);
    const { movement } = await response.json();
    expect(movement).toMatchObject({ createdBy: ownerId, fromLocation: "", custodianLabel: "演出现场" });
    expect((await POST(req({ lotId: lot.id, fromBucket: "checked_out", toBucket: "in_stock",
      quantity: 1, returnOfMovementId: movement.id }, ownerId), ctx)).status).toBe(201);
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 4, checkedOutQuantity: 1 });
  });

  it("同一幂等键重试返回同一流水，不重复扣减；换操作复用会被拒绝", async () => {
    const { material, ctx, body } = await fixture();
    const idempotencyKey = `retry-${shortId()}-${Date.now()}`;
    const first = await POST(req({ ...body, idempotencyKey }, ownerId), ctx);
    const replay = await POST(req({ ...body, idempotencyKey }, ownerId), ctx);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect((await replay.json()).movement.id).toBe((await first.json()).movement.id);
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 3, checkedOutQuantity: 2 });
    expect((await POST(req({ ...body, quantity: 1, idempotencyKey }, ownerId), ctx)).status).toBe(400);
  });

  it("普通项目成员可登记签出给自己并返还自己的物料", async () => {
    const { material, lot, ctx, body } = await fixture();
    const checkout = await POST(req({
      ...body, custodian: { kind: "user", id: viewerId },
    }, viewerId), ctx);
    expect(checkout.status).toBe(201);
    const movement = (await checkout.json()).movement;
    const returned = await POST(req({
      lotId: lot.id, fromBucket: "checked_out", toBucket: "in_stock",
      quantity: 2, returnOfMovementId: movement.id,
    }, viewerId), ctx);
    expect(returned.status).toBe(201);
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 5, checkedOutQuantity: 0 });
  });

  it("责任方 POC 可登记本组日常流转，但调整和永久退出分别要求显式治理键", async () => {
    const { lot, ctx, body } = await fixture(false, true);
    expect((await POST(req({
      ...body, custodian: { kind: "user", id: creatorId },
    }, responsiblePocId), ctx)).status).toBe(201);

    const adjust = {
      lotId: lot.id, fromBucket: "in_stock", toBucket: "adjustment",
      quantity: 1, reason: "盘点校正",
    };
    expect((await POST(req(adjust, responsiblePocId), ctx)).status).toBe(403);
    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,
         grant_source,confirmed_by)
       VALUES ($1,$2,'material','*','stock/adjustments','edit','direct',$2)`,
      [prodId, responsiblePocId],
    );
    expect((await POST(req(adjust, responsiblePocId), ctx)).status).toBe(201);

    const exit = {
      lotId: lot.id, fromBucket: "in_stock", toBucket: "exited",
      quantity: 1, reason: "报废", exitReason: "scrapped",
    };
    expect((await POST(req(exit, responsiblePocId), ctx)).status).toBe(403);
    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,
         grant_source,confirmed_by)
       VALUES ($1,$2,'material','*','stock/exits','edit','direct',$2)`,
      [prodId, responsiblePocId],
    );
    expect((await POST(req(exit, responsiblePocId), ctx)).status).toBe(201);
  });

  it("租借退还出口同时追加库存退出和来源账本，不会只有库存减少", async () => {
    const { material, lot, ctx } = await fixture(true);
    const response = await POST(req({ lotId: lot.id, fromBucket: "in_stock", toBucket: "exited", quantity: 2,
      exitReason: "returned_to_source", reason: "演出后退还" }, ownerId), ctx);
    expect(response.status).toBe(201);
    const sourceReturn = (await response.json()).sourceReturn;
    expect(sourceReturn).toMatchObject({ lotId: lot.id, quantity: 2 });
    expect((await listMaterialStockLots(material.id, prodId))[0])
      .toMatchObject({ inStockQuantity: 3, returnedToSourceQuantity: 2 });
    expect((await listMaterialStockMovements(lot.id, prodId)).find(m => m.id === sourceReturn.movementId))
      .toMatchObject({ exitReason: "returned_to_source", toLocation: "设备仓", reason: "演出后退还" });
  });

  it("来源退还重试返回同一归还事实，不会重复结清义务", async () => {
    const { material, lot, ctx } = await fixture(true);
    const body = { lotId: lot.id, fromBucket: "in_stock", toBucket: "exited", quantity: 2,
      exitReason: "returned_to_source", reason: "演出后退还", idempotencyKey: `return-${shortId()}-${Date.now()}` };
    const first = await POST(req(body, ownerId), ctx);
    const replay = await POST(req(body, ownerId), ctx);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect((await replay.json()).sourceReturn.id).toBe((await first.json()).sourceReturn.id);
    expect((await listMaterialStockLots(material.id, prodId))[0])
      .toMatchObject({ inStockQuantity: 3, returnedToSourceQuantity: 2 });
  });

  it("物料类型接口拒绝旧状态覆盖；字典查询与旧页面读取没有留下双轨", async () => {
    const { material, ctx } = await fixture();
    expect((await PATCH(req({ statusId: "旧状态" }, ownerId, "PATCH"), ctx)).status).toBe(400);
    expect((await PATCH(req({ quantity: 99 }, ownerId, "PATCH"), ctx)).status).toBe(400);
    expect((await PATCH(req({ location: "伪造的新库位" }, ownerId, "PATCH"), ctx)).status).toBe(400);
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 5, checkedOutQuantity: 0, location: "" });
    expect(await getMaterial(material.id, prodId)).not.toHaveProperty("statusId");
    for (const file of ["lib/ops/material-db.ts", "app/production/[id]/materials/page.tsx", "app/api/production/[id]/materials/route.ts", "scripts/seed-local-demo.ts"])
      expect(readFileSync(file, "utf8")).not.toMatch(/production_material_status|listMaterialStatuses|statusName|statusColor/);
  });
});
