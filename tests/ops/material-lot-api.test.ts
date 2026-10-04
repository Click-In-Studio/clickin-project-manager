import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/production/[id]/materials/[materialId]/lots/route";
import { POST as POST_MATERIAL } from "@/app/api/production/[id]/materials/route";
import { POST as POST_SOURCE_EXCEPTION } from "@/app/api/production/[id]/materials/[materialId]/lots/[lotId]/source-exceptions/route";
import { POST as POST_BATCH_RECEIPT } from "@/app/api/production/[id]/materials/[materialId]/movements/batch/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { selfConfirmResourceGrant } from "@/lib/perm/resource-grant-db";
import { appendMaterialStockMovement, createMaterialDefinition, createMaterialStockLots, getMaterialOverview, listMaterialCheckouts, listMaterialStockLots } from "@/lib/ops/material-db";
import { listMaterialIdentifiers } from "@/lib/ops/material-identifier-db";
import { getPool } from "@/lib/pg";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let productionId: string, ownerId: string, outsiderId: string, viewerId: string;
let memberId: string, departmentId: string, materialId: string;

beforeAll(async () => {
  const user = async (name: string) => (await upsertFeishuUser(`lot-${shortId()}`, name, null, false)).userId;
  [ownerId, outsiderId, viewerId, memberId] = await Promise.all([
    user("owner"), user("outsider"), user("viewer"), user("member"),
  ]);
  ({ prodId: productionId } = await makeProduction(ownerId));
  for (const id of [viewerId, memberId]) await addProductionMember(productionId, id);
  const { rows } = await getPool().query<{ id: string }>(
    "INSERT INTO production_dept (production_id,name) VALUES ($1,$2) RETURNING id",
    [productionId, `道具-${shortId()}`],
  );
  departmentId = rows[0].id;
  await getPool().query(
    `INSERT INTO production_dept_member (production_id,dept_id,user_id,is_poc)
     VALUES ($1,$2,$3,false)`, [productionId, departmentId, memberId],
  );
  await getPool().query(
    "DELETE FROM production_member_grant WHERE production_id=$1 AND user_id=$2",
    [productionId, viewerId],
  );
  await selfConfirmResourceGrant(viewerId, productionId, "material", "*", "view");
  materialId = (await createMaterialDefinition({
    productionId, name: "测试灯具", trackingStrategy: "serialized",
    subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
  })).id;
});

afterAll(async () => { await cleanupProduction(productionId).catch(() => {}); });

function request(userId?: string, body: unknown = { confirmedQuantity: 2, sourceType: "existing" }, key = `lot-${shortId()}-${shortId()}`) {
  const req = new NextRequest("http://localhost/api/production/x/materials/x/lots", {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
  });
  if (userId) req.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return req;
}

const ctx = () => ({ params: Promise.resolve({ id: productionId, materialId }) });

describe("物料批次 API", () => {
  it("新增物料类型接口不把建档数量伪装成已入库", async () => {
    const response = await POST_MATERIAL(request(ownerId, {
      name: "新建话筒", category: "音响", trackingStrategy: "serialized", unit: "支",
      departmentId, groupId: null,
    }), { params: Promise.resolve({ id: productionId }) });
    expect(response.status).toBe(201);
    const created = (await response.json()).material;
    expect(created).toMatchObject({ expectedQuantity: 0, inStockQuantity: 0, checkedOutQuantity: 0 });
    expect(await listMaterialStockLots(created.id, productionId)).toHaveLength(0);
  });

  it("未登录 401、非成员 403、仅查看单枚键 403", async () => {
    expect((await POST(request(), ctx())).status).toBe(401);
    expect((await POST(request(outsiderId), ctx())).status).toBe(403);
    expect((await POST(request(viewerId), ctx())).status).toBe(403);
    expect(await listMaterialStockLots(materialId, productionId)).toHaveLength(0);
  });

  it("责任方成员可确认逐件实物，但不会提前写入库流水", async () => {
    const response = await POST(request(memberId), ctx());
    expect(response.status).toBe(201);
    const lots = await listMaterialStockLots(materialId, productionId);
    expect(lots).toHaveLength(2);
    expect(lots.every(lot => lot.confirmedQuantity === 1 && lot.expectedQuantity === 1
      && lot.inStockQuantity === 0 && lot.currentBucket === "expected")).toBe(true);
  });

  it("确认并入库 10 件会原子生成 10 个编号，重放不重复建件", async () => {
    const batchMaterial = await createMaterialDefinition({
      productionId, name: "十个谱架", trackingStrategy: "serialized",
      subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
    });
    const batchCtx = { params: Promise.resolve({ id: productionId, materialId: batchMaterial.id }) };
    const key = `receive-now-${shortId()}`;
    const body = { confirmedQuantity: 10, sourceType: "existing", receiveNow: true };
    const first = await POST(request(memberId, body, key), batchCtx);
    expect(first.status).toBe(201);
    expect((await first.json()).identifiers).toHaveLength(10);
    const replay = await POST(request(memberId, body, key), batchCtx);
    expect(replay.status).toBe(201);
    const lots = await listMaterialStockLots(batchMaterial.id, productionId);
    expect(lots).toHaveLength(10);
    expect(lots.every(lot => lot.currentBucket === "in_stock" && lot.inStockQuantity === 1)).toBe(true);
    expect((await listMaterialIdentifiers(productionId, batchMaterial.id))
      .filter(identifier => identifier.kind === "internal_code")).toHaveLength(10);
  });

  it("批量入库覆盖权限边界，且其中一件已入库时整批不写", async () => {
    const pendingMaterial = await createMaterialDefinition({
      productionId, name: "批量待入库谱架", trackingStrategy: "serialized",
      subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
    });
    const [first, second] = await createMaterialStockLots({
      productionId, materialId: pendingMaterial.id, confirmedQuantity: 2,
      idempotencyKey: `pending-${shortId()}`, createdBy: ownerId,
    });
    await appendMaterialStockMovement({ productionId, lotId: second.id,
      fromBucket: "expected", toBucket: "in_stock", quantity: 1,
      idempotencyKey: `single-${shortId()}`, createdBy: ownerId });
    const batchCtx = { params: Promise.resolve({ id: productionId, materialId: pendingMaterial.id }) };
    const body = { operation: "receipt", items: [first, second].map(lot => ({
      lotId: lot.id, fromBucket: "expected", returnOfMovementId: null,
    })) };
    expect((await POST_BATCH_RECEIPT(request(undefined, body), batchCtx)).status).toBe(401);
    expect((await POST_BATCH_RECEIPT(request(outsiderId, body), batchCtx)).status).toBe(403);
    expect((await POST_BATCH_RECEIPT(request(viewerId, body), batchCtx)).status).toBe(403);
    const failed = await POST_BATCH_RECEIPT(request(memberId, body), batchCtx);
    expect(failed.status).toBe(400);
    const after = await listMaterialStockLots(pendingMaterial.id, productionId);
    expect(after.find(lot => lot.id === first.id)?.currentBucket).toBe("expected");
    expect(after.find(lot => lot.id === second.id)?.currentBucket).toBe("in_stock");
  });

  it("可批量签出、返库并将不同在手状态的实物原子报修", async () => {
    const flowMaterial = await createMaterialDefinition({
      productionId, name: "批量流转谱架", trackingStrategy: "serialized",
      subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
    });
    const flowCtx = { params: Promise.resolve({ id: productionId, materialId: flowMaterial.id }) };
    const lots = await createMaterialStockLots({
      productionId, materialId: flowMaterial.id, confirmedQuantity: 3, receiveNow: true,
      idempotencyKey: `flow-lots-${shortId()}`, createdBy: ownerId,
    });
    const checkoutKey = `batch-checkout-${shortId()}`;
    const checkoutBody = { operation: "checkout", items: lots.map(lot => ({
      lotId: lot.id, fromBucket: "in_stock", returnOfMovementId: null,
    })), custodian: { kind: "user", id: memberId }, custodianLabel: "本人", toLocation: "排练厅" };
    expect((await POST_BATCH_RECEIPT(request(memberId, checkoutBody, checkoutKey), flowCtx)).status).toBe(201);
    const replay = await POST_BATCH_RECEIPT(request(memberId, checkoutBody, checkoutKey), flowCtx);
    expect(replay.status, JSON.stringify(await replay.clone().json())).toBe(201);
    expect((await listMaterialStockLots(flowMaterial.id, productionId))
      .every(lot => lot.currentBucket === "checked_out")).toBe(true);

    const checkouts = await listMaterialCheckouts(flowMaterial.id, productionId);
    const returnLots = lots.slice(0, 2);
    const returnBody = { operation: "return", items: returnLots.map(lot => ({
      lotId: lot.id, fromBucket: "checked_out",
      returnOfMovementId: checkouts.find(checkout => checkout.lotId === lot.id)!.movementId,
    })), toLocation: "道具库" };
    expect((await POST_BATCH_RECEIPT(request(memberId, returnBody), flowCtx)).status).toBe(201);
    const afterReturn = await listMaterialStockLots(flowMaterial.id, productionId);
    expect(afterReturn.filter(lot => lot.currentBucket === "in_stock")).toHaveLength(2);
    expect(afterReturn.filter(lot => lot.currentBucket === "checked_out")).toHaveLength(1);

    const maintenanceBody = { operation: "maintenance", items: [
      { lotId: returnLots[0].id, fromBucket: "in_stock", returnOfMovementId: null },
      { lotId: lots[2].id, fromBucket: "checked_out",
        returnOfMovementId: checkouts.find(checkout => checkout.lotId === lots[2].id)!.movementId },
    ], reason: "批量检查支架" };
    expect((await POST_BATCH_RECEIPT(request(memberId, maintenanceBody), flowCtx)).status).toBe(201);
    const afterMaintenance = await listMaterialStockLots(flowMaterial.id, productionId);
    expect(afterMaintenance.filter(lot => lot.currentBucket === "maintenance")).toHaveLength(2);
  });

  it("责任方普通成员不能顺带登记租赁来源", async () => {
    const response = await POST(request(memberId, {
      confirmedQuantity: 1, sourceType: "rented", sourceLabel: "外部器材库",
      returnDueAt: "2026-12-01T00:00:00.000Z",
    }), ctx());
    expect(response.status).toBe(403);
  });

  it("来源异常路由对未登录、非成员和仅日常维护成员关闭，owner 可登记", async () => {
    const rented = await createMaterialDefinition({
      productionId, name: "租赁灯具", subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
    });
    const [lot] = await createMaterialStockLots({
      productionId, materialId: rented.id, confirmedQuantity: 2, sourceType: "rented",
      sourceLabel: "外部器材库", returnDueAt: new Date("2026-12-01T00:00:00Z"),
      idempotencyKey: "test-rented-lot-batch", createdBy: ownerId,
    });
    const exceptionCtx = { params: Promise.resolve({ id: productionId, materialId: rented.id, lotId: lot.id }) };
    const exceptionRequest = (userId?: string) => request(userId, { kind: "lost", quantity: 1, note: "清点少件" });
    expect((await POST_SOURCE_EXCEPTION(exceptionRequest(), exceptionCtx)).status).toBe(401);
    expect((await POST_SOURCE_EXCEPTION(exceptionRequest(outsiderId), exceptionCtx)).status).toBe(403);
    expect((await POST_SOURCE_EXCEPTION(exceptionRequest(viewerId), exceptionCtx)).status).toBe(403);
    expect((await POST_SOURCE_EXCEPTION(exceptionRequest(memberId), exceptionCtx)).status).toBe(403);
    expect((await POST_SOURCE_EXCEPTION(exceptionRequest(ownerId), exceptionCtx)).status).toBe(201);
  });

  it("总览按实物或批次统计五类待办，并为筛选返回物料类型集合", async () => {
    const before = await getMaterialOverview(productionId, new Date("2027-01-01T00:00:00Z"));
    const devices = await createMaterialDefinition({
      productionId, name: "总览测试设备", trackingStrategy: "serialized",
      subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
    });
    const deviceLots = await createMaterialStockLots({
      productionId, materialId: devices.id, confirmedQuantity: 3, receiveNow: true,
      idempotencyKey: `overview-device-${shortId()}`, createdBy: ownerId,
    });
    for (const lot of deviceLots.slice(0, 2)) await appendMaterialStockMovement({
      productionId, lotId: lot.id, fromBucket: "in_stock", toBucket: "checked_out", quantity: 1,
      custodian: { kind: "user", id: memberId }, idempotencyKey: `overview-out-${shortId()}`,
      createdBy: ownerId,
    });
    await appendMaterialStockMovement({
      productionId, lotId: deviceLots[2].id, fromBucket: "in_stock", toBucket: "maintenance", quantity: 1,
      reason: "检修", idempotencyKey: `overview-maintenance-${shortId()}`, createdBy: ownerId,
    });
    const rental = await createMaterialDefinition({
      productionId, name: "总览测试租赁批次", trackingStrategy: "bulk_returnable",
      subject: { kind: "dept", id: departmentId }, createdBy: ownerId,
    });
    const [rentalLot] = await createMaterialStockLots({
      productionId, materialId: rental.id, confirmedQuantity: 10, sourceType: "rented",
      sourceLabel: "测试租赁方", returnDueAt: new Date("2026-01-01T00:00:00Z"),
      returnDueQuantity: 10, idempotencyKey: `overview-rental-${shortId()}`, createdBy: ownerId,
    });
    const exceptionCtx = { params: Promise.resolve({ id: productionId, materialId: rental.id, lotId: rentalLot.id }) };
    expect((await POST_SOURCE_EXCEPTION(request(ownerId, {
      kind: "short", quantity: 1, note: "少到一件",
    }), exceptionCtx)).status).toBe(201);

    const overview = await getMaterialOverview(productionId, new Date("2027-01-01T00:00:00Z"));
    expect(overview.checkedOut.count - before.checkedOut.count).toBe(2);
    expect(overview.maintenance.count - before.maintenance.count).toBe(1);
    expect(overview.pendingReceipt.count - before.pendingReceipt.count).toBe(1);
    expect(overview.overdueSourceReturn.count - before.overdueSourceReturn.count).toBe(1);
    expect(overview.sourceException.count - before.sourceException.count).toBe(1);
    expect(overview.checkedOut.materialIds.filter(id => id === devices.id)).toHaveLength(1);
    expect(overview.maintenance.materialIds).toContain(devices.id);
    expect(overview.pendingReceipt.materialIds).toContain(rental.id);
    expect(overview.overdueSourceReturn.materialIds).toContain(rental.id);
    expect(overview.sourceException.materialIds).toContain(rental.id);
  });
});
