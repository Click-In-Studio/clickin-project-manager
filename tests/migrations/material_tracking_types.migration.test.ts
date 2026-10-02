import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH, type MaterialTrackingTypesSnapshot,
} from "./material_tracking_types.snapshot";

let snapshot: MaterialTrackingTypesSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as MaterialTrackingTypesSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("物料定义具有跟踪策略、固定单位和精度，流水具有返还引用", async () => {
    const columns = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND ((table_name='production_material'
                AND column_name=ANY($1::text[]))
            OR (table_name='production_material_stock_movement'
                AND column_name='return_of_movement_id'))
        ORDER BY table_name, column_name`,
      [["tracking_strategy", "unit", "quantity_scale"]],
    );
    expect(columns.rows).toEqual([
      { table_name: "production_material", column_name: "quantity_scale" },
      { table_name: "production_material", column_name: "tracking_strategy" },
      { table_name: "production_material", column_name: "unit" },
      { table_name: "production_material_stock_movement", column_name: "return_of_movement_id" },
    ]);
  });
});

describe("integrity verification", () => {
  it.skipIf(!snapshot)("有库存后不可改跟踪口径，返还必须引用原签出", async () => {
    await expect(getPool().query(
      "UPDATE production_material SET unit='箱' WHERE id=$1",
      [snapshot!.materialId],
    )).rejects.toThrow(/cannot change/);

    const checkoutId = `mm_checkout_${Date.now().toString(36)}`;
    await getPool().query(
      `INSERT INTO production_material_stock_movement
         (id, production_id, lot_id, from_bucket, to_bucket, quantity, created_by)
       VALUES ($1,$2,$3,'in_stock','checked_out',2,$4)`,
      [checkoutId, snapshot!.productionId, snapshot!.lotId, snapshot!.createdBy],
    );
    await expect(getPool().query(
      `INSERT INTO production_material_stock_movement
         (id, production_id, lot_id, from_bucket, to_bucket, quantity, created_by)
       VALUES ($1,$2,$3,'checked_out','in_stock',1,$4)`,
      [`mm_return_${Date.now().toString(36)}`, snapshot!.productionId,
        snapshot!.lotId, snapshot!.createdBy],
    )).rejects.toThrow(/must reference/);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("旧物料按批量可返还、件和整数精度迁移，库存事实不变", async () => {
    const result = await getPool().query<{
      tracking_strategy: string; unit: string; quantity_scale: number;
      confirmed_quantity: string; from_bucket: string; to_bucket: string;
      quantity: string; return_of_movement_id: string | null;
    }>(
      `SELECT m.tracking_strategy, m.unit, m.quantity_scale,
              l.confirmed_quantity::text, sm.from_bucket, sm.to_bucket,
              sm.quantity::text, sm.return_of_movement_id
         FROM production_material m
         JOIN production_material_stock_lot l ON l.material_id=m.id
         JOIN production_material_stock_movement sm ON sm.id=$2
        WHERE m.id=$1`,
      [snapshot!.materialId, snapshot!.receiptId],
    );
    expect(result.rows).toEqual([{
      tracking_strategy: "bulk_returnable",
      unit: "件",
      quantity_scale: 0,
      confirmed_quantity: "4.000",
      from_bucket: "expected",
      to_bucket: "in_stock",
      quantity: "4.000",
      return_of_movement_id: null,
    }]);
  });
});
