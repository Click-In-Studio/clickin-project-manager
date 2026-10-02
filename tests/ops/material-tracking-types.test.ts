import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import {
  appendMaterialStockMovement, createMaterial, createMaterialStockLot, getMaterial,
  listMaterialCheckouts, listMaterialStockLots, listMaterialStockMovements,
  updateMaterial,
} from "@/lib/ops/material-db";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let prodId: string;
let ownerId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(
    `test-open-${shortId()}`, `物料类型${shortId()}`, null, false,
  )).userId;
  ({ prodId } = await makeProduction(ownerId));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("逐件跟踪", () => {
  it("数量 N 建成 N 个数量恒为 1 的独立实物载体", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `SER-${shortId()}`, name: "无线话筒",
      category: "设备", trackingStrategy: "serialized", unit: "台", quantityScale: 0,
      quantity: 3, subject: null, createdBy: ownerId,
    });
    const lots = await listMaterialStockLots(material.id, prodId);
    expect(lots).toHaveLength(3);
    expect(new Set(lots.map(lot => lot.id)).size).toBe(3);
    expect(lots.every(lot => lot.confirmedQuantity === 1)).toBe(true);
    expect(lots.every(lot => lot.currentBucket === "in_stock")).toBe(true);
    expect(material).toMatchObject({
      category: "设备", trackingStrategy: "serialized", unit: "台",
      quantityScale: 0, inStockQuantity: 3,
    });
    for (const lot of lots) {
      const movements = await listMaterialStockMovements(lot.id, prodId);
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ quantity: 1, fromBucket: "expected", toBucket: "in_stock" });
    }
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lots[0].id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 1, createdBy: ownerId,
    });
    expect((await listMaterialStockLots(material.id, prodId)).find(lot => lot.id === lots[0].id))
      .toMatchObject({ currentBucket: "checked_out", checkedOutQuantity: 1, inStockQuantity: 0 });
    await expect(createMaterialStockLot({
      productionId: prodId, materialId: material.id, confirmedQuantity: 2,
      createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_quantity" });
  });
});

describe("批量返还与耗材", () => {
  it("一次签出可多次部分返还，累计返还不得超过原签出", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `RET-${shortId()}`, name: "折叠椅",
      trackingStrategy: "bulk_returnable", unit: "把", quantity: 15,
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    expect(await listMaterialStockLots(material.id, prodId)).toHaveLength(1);
    const checkout = await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 5, createdBy: ownerId,
    });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 5, createdBy: ownerId,
    });
    for (const quantity of [2, 1]) {
      await appendMaterialStockMovement({
        productionId: prodId, lotId: lot.id, fromBucket: "checked_out",
        toBucket: "in_stock", quantity, returnOfMovementId: checkout.id,
        createdBy: ownerId,
      });
    }
    expect(await listMaterialCheckouts(material.id, prodId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        movementId: checkout.id, checkedOutQuantity: 5,
        returnedQuantity: 3, outstandingQuantity: 2,
      }),
    ]));
    await expect(appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "checked_out",
      toBucket: "in_stock", quantity: 3, returnOfMovementId: checkout.id,
      createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "return_overflow" });
  });

  it("返还不引用签出就不回补；耗材净消耗随已登记返还减少", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `CON-${shortId()}`, name: "黑色胶带",
      trackingStrategy: "consumable", unit: "卷", quantity: 8,
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    expect(await listMaterialStockLots(material.id, prodId)).toHaveLength(1);
    const checkout = await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 5, createdBy: ownerId,
    });
    expect(await getMaterial(material.id, prodId)).toMatchObject({
      inStockQuantity: 3, checkedOutQuantity: 5, netConsumedQuantity: 5,
    });
    await expect(appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "checked_out",
      toBucket: "in_stock", quantity: 1, createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "return_required" });
    expect(await getMaterial(material.id, prodId)).toMatchObject({
      inStockQuantity: 3, checkedOutQuantity: 5, netConsumedQuantity: 5,
    });
    await appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "checked_out",
      toBucket: "in_stock", quantity: 3, returnOfMovementId: checkout.id,
      createdBy: ownerId,
    });
    expect(await getMaterial(material.id, prodId)).toMatchObject({
      inStockQuantity: 6, checkedOutQuantity: 2, netConsumedQuantity: 2,
    });
  });
});

describe("单位、精度与策略切换", () => {
  it("精确十进制按物料精度校验，底层不锁死整数", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `DEC-${shortId()}`, name: "舞台绳",
      trackingStrategy: "bulk_returnable", unit: "米", quantityScale: 2,
      quantity: 12.25, subject: null, createdBy: ownerId,
    });
    expect(material).toMatchObject({ unit: "米", quantityScale: 2, inStockQuantity: 12.25 });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    await expect(appendMaterialStockMovement({
      productionId: prodId, lotId: lot.id, fromBucket: "in_stock",
      toBucket: "checked_out", quantity: 0.125, createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_precision" });
  });

  it("有库存事实后不可修改策略、单位或精度；空定义可以修改", async () => {
    const material = await createMaterial({
      productionId: prodId, code: `LOCK-${shortId()}`, name: "锁定类型",
      subject: null, createdBy: ownerId,
    });
    for (const patch of [
      { trackingStrategy: "consumable" as const }, { unit: "箱" }, { quantityScale: 2 },
    ]) {
      await expect(updateMaterial(material.id, prodId, patch))
        .rejects.toMatchObject({ reason: "tracking_has_history" });
    }

    const empty = await getPool().query<{ id: string }>(
      `INSERT INTO production_material
         (production_id, code, name, category, created_by)
       VALUES ($1,$2,'空定义','设备',$3) RETURNING id`,
      [prodId, `EMPTY-${shortId()}`, ownerId],
    );
    const updated = await updateMaterial(empty.rows[0].id, prodId, {
      trackingStrategy: "serialized", unit: "台", quantityScale: 0,
    });
    expect(updated).toMatchObject({ trackingStrategy: "serialized", unit: "台", quantityScale: 0 });
  });
});
