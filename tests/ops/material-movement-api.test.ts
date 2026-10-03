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
beforeAll(async () => {
  const user = async () => (await upsertFeishuUser(`test-open-${shortId()}`, "流转 API", null, false)).userId;
  [ownerId, outsiderId, viewerId, creatorId] = await Promise.all([user(), user(), user(), user()]);
  ({ prodId } = await makeProduction(ownerId));
  for (const id of [ownerId, viewerId, creatorId]) await addProductionMember(prodId, id);
  await getPool().query("DELETE FROM production_member_grant WHERE production_id=$1 AND user_id=ANY($2::uuid[])", [prodId, [viewerId, creatorId]]);
  await selfConfirmResourceGrant(viewerId, prodId, "material", "*", "view");
  await selfConfirmResourceGrant(creatorId, prodId, "material", "*", "create");
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

function req(body: unknown, userId?: string, method = "POST") {
  const request = new NextRequest("http://localhost/api/production/x/materials/x/movements", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (userId) request.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return request;
}
async function fixture(rented = false) {
  const material = await createMaterial({ productionId: prodId, name: "线缆",
    quantity: 5, subject: null, createdBy: ownerId,
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

  it("定义接口拒绝旧状态覆盖；字典查询与旧页面读取没有留下双轨", async () => {
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
