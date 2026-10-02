import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import {
  appendMaterialStockMovement, createMaterial, createMaterialStockLot,
  listMaterialStockLots,
} from "@/lib/ops/material-db";
import {
  listMaterialSourceExceptions, listMaterialSourceObligations,
  recordMaterialSourceException, recordMaterialSourceReturn,
  resolveMaterialSourceException,
} from "@/lib/ops/material-source-db";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let prodId: string;
let ownerId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(
    `test-open-${shortId()}`, `物料来源${shortId()}`, null, false,
  )).userId;
  ({ prodId } = await makeProduction(ownerId));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("批次来源快照与到货", () => {
  it("同一物料可以同时持有既有、租赁和借用批次", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `MIX-${shortId()}`, name: "无线话筒",
      trackingStrategy: "bulk_returnable", quantity: 2,
      subject: null, createdBy: ownerId,
    });
    await createMaterialStockLot({
      productionId: prodId, materialId: material.id, confirmedQuantity: 4,
      sourceType: "rented", sourceLabel: "城南设备仓", sourceReference: "R-1024",
      returnDueAt: new Date("2026-11-02T10:00:00+08:00"), createdBy: ownerId,
    });
    await createMaterialStockLot({
      productionId: prodId, materialId: material.id, confirmedQuantity: 1,
      sourceType: "borrowed", sourceLabel: "兄弟剧团",
      returnDueAt: new Date("2026-11-03T10:00:00+08:00"), createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId)).map(lot => lot.sourceType))
      .toEqual(["existing", "rented", "borrowed"]);
  });

  it("实际到货数量和时间由有效流水派生", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `ARR-${shortId()}`, name: "折叠椅",
      quantity: 1, subject: null, createdBy: ownerId,
    });
    const lot = await createMaterialStockLot({
      productionId: prodId, materialId: material.id, confirmedQuantity: 10,
      sourceType: "purchased", sourceLabel: "采购订单 A",
      expectedArrivalAt: new Date("2026-10-10T09:00:00+08:00"), createdBy: ownerId,
    });
    const firstArrival = new Date("2026-10-09T15:30:00+08:00");
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "expected", toBucket: "in_stock",
      quantity: 4, occurredAt: firstArrival, createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId)).find(row => row.id === lot.id))
      .toMatchObject({
        arrivedQuantity: 4, actualArrivalAt: firstArrival.toISOString(),
        sourceStatus: "partially_arrived",
      });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "expected", toBucket: "in_stock",
      quantity: 6, occurredAt: new Date("2026-10-10T08:00:00+08:00"), createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId)).find(row => row.id === lot.id))
      .toMatchObject({ arrivedQuantity: 10, sourceStatus: "fully_arrived" });
  });
});

describe("退还来源方与异常", () => {
  it("租来 10、退还 9、遗失 1 时保持异常，解决并归还后才退清", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `RENT-${shortId()}`, name: "演出灯具",
      quantity: 10, sourceType: "rented", sourceLabel: "灯光租赁仓",
      sourceReference: "LEASE-77", returnDueAt: new Date("2026-10-20T18:00:00+08:00"),
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    const sourceReturn = await recordMaterialSourceReturn({
      productionId: prodId, lotId: lot.id, quantity: 9,
      returnedAt: new Date("2026-10-20T16:00:00+08:00"),
      exceptions: [{ kind: "lost", quantity: 1, note: "现场清点少一台" }],
      createdBy: ownerId,
    });
    expect(sourceReturn.exceptions).toHaveLength(1);
    expect((await listMaterialStockLots(material.id, prodId))[0]).toMatchObject({
      inStockQuantity: 1, exitedQuantity: 9, returnedToSourceQuantity: 9,
      openSourceExceptionQuantity: 1, sourceStatus: "exception_open",
    });
    expect((await listMaterialSourceObligations(prodId)).find(row => row.lotId === lot.id))
      .toMatchObject({ returnedQuantity: 9, outstandingQuantity: 1, status: "exception_open" });

    const [lost] = (await listMaterialSourceExceptions(lot.id, prodId))
      .filter(issue => issue.resolvesExceptionId === null);
    await resolveMaterialSourceException({
      productionId: prodId, lotId: lot.id, exceptionId: lost.id,
      note: "已找回", createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId))[0])
      .toMatchObject({ openSourceExceptionQuantity: 0, sourceStatus: "partially_returned" });
    await recordMaterialSourceReturn({
      productionId: prodId, lotId: lot.id, quantity: 1, createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId))[0])
      .toMatchObject({ returnedToSourceQuantity: 10, sourceStatus: "fully_returned" });
  });

  it("内部签出返库不会被误记为退还来源方", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `INNER-${shortId()}`, name: "租赁桌椅",
      quantity: 5, sourceType: "borrowed", sourceLabel: "社区礼堂",
      returnDueAt: new Date("2026-12-01T12:00:00+08:00"),
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    const checkout = await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 3, createdBy: ownerId,
    });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "checked_out",
      toBucket: "in_stock", quantity: 3, returnOfMovementId: checkout.id, createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId))[0]).toMatchObject({
      returnedToSourceQuantity: 0, inStockQuantity: 5, sourceStatus: "fully_arrived",
    });
  });

  it("非租借批次不能登记对外归还，累计归还不得超过应还数量", async () => {
    await expect(createMaterial({
      productionId: prodId, code: `NO-DUE-${shortId()}`, name: "缺应还时间",
      quantity: 1, sourceType: "rented", sourceLabel: "设备仓",
      subject: null, createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_source" });

    const owned = await createMaterial({
      productionId: prodId, code: `OWN-${shortId()}`, name: "自有箱",
      quantity: 2, subject: null, createdBy: ownerId,
    });
    const [ownedLot] = await listMaterialStockLots(owned.id, prodId);
    await expect(recordMaterialSourceReturn({
      productionId: prodId, lotId: ownedLot.id, quantity: 1, createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_source" });

    const rented = await createMaterial({
      productionId: prodId, code: `CAP-${shortId()}`, name: "租赁线缆",
      quantity: 3, sourceType: "rented", sourceLabel: "线缆库",
      returnDueQuantity: 2, returnDueAt: new Date("2026-12-02T12:00:00+08:00"),
      subject: null, createdBy: ownerId,
    });
    const [rentedLot] = await listMaterialStockLots(rented.id, prodId);
    await recordMaterialSourceReturn({
      productionId: prodId, lotId: rentedLot.id, quantity: 2, createdBy: ownerId,
    });
    await expect(recordMaterialSourceReturn({
      productionId: prodId, lotId: rentedLot.id, quantity: 1, createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "source_return_overflow" });
    await expect(recordMaterialSourceException({
      productionId: prodId, lotId: rentedLot.id,
      input: { kind: "lost", quantity: 1 }, createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_source_exception" });

    const damaged = await createMaterial({
      productionId: prodId, code: `DMG-${shortId()}`, name: "租赁调音台",
      quantity: 3, sourceType: "rented", sourceLabel: "音响中心",
      returnDueAt: new Date("2026-12-04T12:00:00+08:00"),
      subject: null, createdBy: ownerId,
    });
    const [damagedLot] = await listMaterialStockLots(damaged.id, prodId);
    await expect(recordMaterialSourceReturn({
      productionId: prodId, lotId: damagedLot.id, quantity: 1,
      exceptions: [{ kind: "damaged", quantity: 2 }], createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_source_exception" });
  });

  it("项目级读模型可查询到期但未退清事实", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `DUE-${shortId()}`, name: "借用投影仪",
      trackingStrategy: "serialized", quantity: 1,
      sourceType: "borrowed", sourceLabel: "校团委",
      returnDueAt: new Date("2020-01-01T00:00:00Z"),
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    expect((await listMaterialSourceObligations(prodId)).find(row => row.lotId === lot.id))
      .toMatchObject({ outstandingQuantity: 1, isOverdue: true, status: "fully_arrived" });
    await recordMaterialSourceException({
      productionId: prodId, lotId: lot.id,
      input: { kind: "damaged", quantity: 1 }, createdBy: ownerId,
    });
    expect((await listMaterialSourceObligations(prodId)).find(row => row.lotId === lot.id))
      .toMatchObject({ openExceptionQuantity: 1, status: "exception_open" });
  });

  it("并发退还按批次串行校验，不会突破应还数量", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `RACE-${shortId()}`, name: "租赁配重",
      quantity: 4, sourceType: "rented", sourceLabel: "舞台设备中心",
      returnDueQuantity: 3, returnDueAt: new Date("2026-12-03T12:00:00+08:00"),
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    const results = await Promise.allSettled([1, 2].map(() => recordMaterialSourceReturn({
      productionId: prodId, lotId: lot.id, quantity: 2, createdBy: ownerId,
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await listMaterialSourceObligations(prodId)).find(row => row.lotId === lot.id))
      .toMatchObject({ returnedQuantity: 2, outstandingQuantity: 1 });
  });
});
