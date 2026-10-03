import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import {
  appendMaterialStockMovement as move, createMaterial, createMaterialStockLot,
  getMaterial, listMaterialCheckouts, listMaterialStockLots, listMaterialStockMovements,
} from "@/lib/ops/material-db";
import { listMaterialSourceObligations, recordMaterialSourceException, recordMaterialSourceReturn } from "@/lib/ops/material-source-db";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let prodId: string, otherProdId: string, ownerId: string;
beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, "物料流转测试", null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  ({ prodId: otherProdId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

async function fixture(strategy: "serialized" | "bulk_returnable" | "consumable" = "bulk_returnable", quantity = 10) {
  const material = await createMaterial({ productionId: prodId, code: `LC-${shortId()}`,
    name: "设备或耗材", trackingStrategy: strategy, quantity, subject: null,
    location: "仓库 A", createdBy: ownerId });
  const [lot] = await listMaterialStockLots(material.id, prodId);
  return { material, lot, base: { productionId: prodId, lotId: lot.id, createdBy: ownerId } };
}

async function event(productionId = prodId) {
  const id = `ev_${shortId()}`;
  await getPool().query(`INSERT INTO production_event (id,production_id,title,event_type,created_by)
    VALUES ($1,$2,'首演','performance',$3)`, [id, productionId, ownerId]);
  return id;
}
async function task(eventId: string | null, productionId = prodId) {
  const id = `tk_${shortId()}`;
  await getPool().query(`INSERT INTO task (id,production_id,event_id,title)
    VALUES ($1,$2,$3,'舞台布置')`, [id, productionId, eventId]);
  return id;
}

describe("确定状态机", () => {
  it("禁止跳过到货、退出后复活、耗材维修，失败不留流水", async () => {
    const { material, base } = await fixture("consumable");
    const lot = await createMaterialStockLot({ productionId: prodId, materialId: material.id,
      confirmedQuantity: 5, createdBy: ownerId });
    await expect(move({ ...base, lotId: lot.id, fromBucket: "expected", toBucket: "checked_out", quantity: 1 }))
      .rejects.toMatchObject({ reason: "bad_transition" });
    expect(await listMaterialStockMovements(lot.id, prodId)).toHaveLength(0);
    await expect(move({ ...base, fromBucket: "in_stock", toBucket: "maintenance", quantity: 1, reason: "损坏" }))
      .rejects.toMatchObject({ reason: "bad_transition" });
    await move({ ...base, fromBucket: "in_stock", toBucket: "exited", quantity: 1, reason: "售出", exitReason: "sold" });
    await expect(move({ ...base, fromBucket: "exited", toBucket: "in_stock", quantity: 1 }))
      .rejects.toMatchObject({ reason: "bad_transition" });
  });

  it("未到部分可以取消，租借义务与到货状态不再包含取消部分", async () => {
    const { material } = await fixture();
    const lot = await createMaterialStockLot({ productionId: prodId, materialId: material.id,
      confirmedQuantity: 10, sourceType: "rented", sourceLabel: "设备仓",
      returnDueAt: new Date("2026-12-01T00:00:00Z"), createdBy: ownerId });
    const base = { productionId: prodId, lotId: lot.id, createdBy: ownerId };
    await move({ ...base, fromBucket: "expected", toBucket: "in_stock", quantity: 4 });
    await expect(move({ ...base, fromBucket: "expected", toBucket: "cancelled", quantity: 6 }))
      .rejects.toMatchObject({ reason: "reason_required" });
    await move({ ...base, fromBucket: "expected", toBucket: "cancelled", quantity: 6, reason: "双方确认取消剩余" });
    expect((await listMaterialStockLots(material.id, prodId)).find(l => l.id === lot.id))
      .toMatchObject({ expectedQuantity: 0, inStockQuantity: 4, cancelledQuantity: 6, sourceStatus: "fully_arrived" });
    expect((await listMaterialSourceObligations(prodId)).find(l => l.lotId === lot.id))
      .toMatchObject({ returnDueQuantity: 4, outstandingQuantity: 4 });
  });

  it("已签出设备送修必须结清原签出，修复返库，退出原因保留", async () => {
    const { material, lot, base } = await fixture("serialized", 1);
    const checkout = await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 1 });
    await expect(move({ ...base, fromBucket: "checked_out", toBucket: "maintenance", quantity: 1, reason: "损坏" }))
      .rejects.toMatchObject({ reason: "return_required" });
    await move({ ...base, fromBucket: "checked_out", toBucket: "maintenance", quantity: 1,
      returnOfMovementId: checkout.id, reason: "损坏" });
    expect((await listMaterialCheckouts(material.id, prodId))[0])
      .toMatchObject({ returnedQuantity: 0, settledQuantity: 1, outstandingQuantity: 0 });
    await move({ ...base, fromBucket: "maintenance", toBucket: "in_stock", quantity: 1, note: "维修完成" });
    const exit = await move({ ...base, fromBucket: "in_stock", toBucket: "exited", quantity: 1,
      exitReason: "scrapped", reason: "无法满足安全要求" });
    expect(exit).toMatchObject({ operation: "exit", exitReason: "scrapped", sourceBefore: 1, sourceAfter: 0 });
    expect((await listMaterialStockLots(material.id, prodId)).find(l => l.id === lot.id))
      .toMatchObject({ currentBucket: "exited" });
  });

  it("租借取消部分后，退出必须与来源归还记账一致，不能靠校正多退", async () => {
    const { material } = await fixture();
    const lot = await createMaterialStockLot({ productionId: prodId, materialId: material.id,
      confirmedQuantity: 10, sourceType: "borrowed", sourceLabel: "友团",
      returnDueAt: new Date("2026-12-01T00:00:00Z"), createdBy: ownerId });
    const base = { productionId: prodId, lotId: lot.id, createdBy: ownerId };
    await move({ ...base, fromBucket: "expected", toBucket: "in_stock", quantity: 4 });
    await move({ ...base, fromBucket: "expected", toBucket: "cancelled", quantity: 6, reason: "取消未到部分" });
    await expect(move({ ...base, fromBucket: "in_stock", toBucket: "exited", quantity: 1,
      reason: "退还", exitReason: "returned_to_source" })).rejects.toMatchObject({ reason: "bad_source_return" });
    await move({ ...base, fromBucket: "adjustment", toBucket: "in_stock", quantity: 1, reason: "盘点补记" });
    await expect(recordMaterialSourceReturn({ ...base, quantity: 5 }))
      .rejects.toMatchObject({ reason: "source_return_overflow" });
    await expect(recordMaterialSourceException({ ...base, input: { kind: "lost", quantity: 5, note: "遗失" } }))
      .rejects.toMatchObject({ reason: "bad_source_exception" });
    expect((await listMaterialStockLots(material.id, prodId)).find(l => l.id === lot.id))
      .toMatchObject({ inStockQuantity: 5, exitedQuantity: 0, returnedToSourceQuantity: 0 });
    await recordMaterialSourceReturn({ ...base, quantity: 4 });
    expect((await listMaterialStockLots(material.id, prodId)).find(l => l.id === lot.id))
      .toMatchObject({ inStockQuantity: 1, returnedToSourceQuantity: 4, sourceStatus: "fully_returned" });
  });

  it("完全取消的载体不被展示为仍待到货；按件数量纠错必须使用精确冲销", async () => {
    const { material, base } = await fixture("serialized", 1);
    await expect(move({ ...base, fromBucket: "adjustment", toBucket: "in_stock", quantity: 1, reason: "盘点" }))
      .rejects.toMatchObject({ reason: "bad_transition" });
    const lot = await createMaterialStockLot({ productionId: prodId, materialId: material.id,
      confirmedQuantity: 1, createdBy: ownerId });
    await move({ ...base, lotId: lot.id, fromBucket: "expected", toBucket: "cancelled", quantity: 1, reason: "取消订购" });
    expect((await listMaterialStockLots(material.id, prodId)).find(l => l.id === lot.id))
      .toMatchObject({ expectedQuantity: 0, cancelledQuantity: 1, sourceStatus: "cancelled", currentBucket: "cancelled" });
  });
});

describe("用途与经手快照", () => {
  it("event/task 可同时关联；返还继承签出快照，删除实体不会抹掉历史", async () => {
    const { material, lot, base } = await fixture("consumable");
    const eventId = await event(), taskId = await task(eventId);
    const checkout = await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 5,
      eventId, taskId, custodian: { kind: "user", id: ownerId }, fromLocation: "仓库 A", toLocation: "主舞台" });
    expect(checkout).toMatchObject({ eventId, eventTitle: "首演", taskId, taskTitle: "舞台布置",
      custodian: { kind: "user", id: ownerId }, fromLocation: "仓库 A", toLocation: "主舞台" });
    await getPool().query("UPDATE task SET title='改名',event_id=NULL WHERE id=$1", [taskId]);
    await getPool().query("DELETE FROM task WHERE id=$1", [taskId]);
    await getPool().query("DELETE FROM production_event WHERE id=$1", [eventId]);
    const returned = await move({ ...base, fromBucket: "checked_out", toBucket: "in_stock", quantity: 3,
      returnOfMovementId: checkout.id, fromLocation: "主舞台", toLocation: "仓库 A" });
    expect(returned).toMatchObject({ eventId, eventTitle: "首演", taskId, taskTitle: "舞台布置" });
    expect(await listMaterialCheckouts(null, prodId, { eventId, taskId })).toEqual([
      expect.objectContaining({ movementId: checkout.id, returnedQuantity: 3, outstandingQuantity: 2 })]);
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 8, netConsumedQuantity: 2 });
    expect(await listMaterialStockMovements(lot.id, prodId)).toHaveLength(3);
  });

  it("拒绝跨项目、event/task 冲突以及返还用途改写；可以只挂独立任务", async () => {
    const { base } = await fixture();
    const eventId = await event(), otherEventId = await event(), taskId = await task(eventId);
    const foreign = await event(otherProdId);
    for (const use of [{ eventId: foreign }, { eventId: otherEventId, taskId }, { taskId: "missing" }]) {
      await expect(move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 1, ...use }))
        .rejects.toMatchObject({ reason: "bad_use" });
    }
    const independentTask = await task(null);
    const checkout = await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 2, taskId: independentTask });
    await expect(move({ ...base, fromBucket: "checked_out", toBucket: "in_stock", quantity: 1,
      returnOfMovementId: checkout.id, eventId }))
      .rejects.toMatchObject({ reason: "bad_use" });
    await expect(move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 1,
      custodian: { kind: "event", id: foreign } })).rejects.toMatchObject({ reason: "bad_use" });
  });

  it("登记库位不是当前来源位置；未填写的位置不伪造为初始库位", async () => {
    const { material, base } = await fixture("serialized", 1);
    const checkout = await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 1,
      fromLocation: "仓库 A", toLocation: "主舞台", custodianLabel: "外借剧团" });
    await move({ ...base, fromBucket: "checked_out", toBucket: "in_stock", quantity: 1,
      returnOfMovementId: checkout.id, toLocation: "仓库 B" });
    const next = await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 1 });
    expect(next.fromLocation).toBe("");
    expect(await getMaterial(material.id, prodId)).toMatchObject({ location: "仓库 A", departmentId: null, groupId: null });
  });
});

describe("校正与冲销", () => {
  it("批量盘点差额追加并记录前后余额；反向纠错不会覆盖历史", async () => {
    const { material, lot, base } = await fixture();
    await expect(move({ ...base, fromBucket: "in_stock", toBucket: "adjustment", quantity: 2 }))
      .rejects.toMatchObject({ reason: "reason_required" });
    const down = await move({ ...base, fromBucket: "in_stock", toBucket: "adjustment", quantity: 2, reason: "清点少两件" });
    expect(down).toMatchObject({ operation: "adjustment", sourceBefore: 10, sourceAfter: 8, targetBefore: 0, targetAfter: 2 });
    const up = await move({ ...base, fromBucket: "adjustment", toBucket: "in_stock", quantity: 3, reason: "找回并补记" });
    expect(up).toMatchObject({ targetBefore: 8, targetAfter: 11 });
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 11, exitedQuantity: 0 });
    const reverse = await move({ ...base, fromBucket: "in_stock", toBucket: "adjustment", quantity: 3,
      reversesEventId: up.id, reason: "多记了三件" });
    expect(await getMaterial(material.id, prodId)).toMatchObject({ inStockQuantity: 8 });
    await expect(move({ ...base, fromBucket: "adjustment", toBucket: "in_stock", quantity: 3,
      reversesEventId: reverse.id, reason: "重复冲销" })).rejects.toMatchObject({ reason: "bad_reversal" });
    expect(await listMaterialStockMovements(lot.id, prodId)).toHaveLength(4);
  });

  it("有有效返还的签出不能整笔冲销，避免抹掉其他签出的余额", async () => {
    const { base } = await fixture();
    const first = await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 4 });
    await move({ ...base, fromBucket: "in_stock", toBucket: "checked_out", quantity: 4 });
    await move({ ...base, fromBucket: "checked_out", toBucket: "in_stock", quantity: 2, returnOfMovementId: first.id });
    await expect(move({ ...base, fromBucket: "checked_out", toBucket: "in_stock", quantity: 4,
      reversesEventId: first.id, reason: "错误冲销" })).rejects.toMatchObject({ reason: "bad_reversal" });
  });
});
