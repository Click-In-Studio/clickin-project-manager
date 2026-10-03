import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH, type MaterialLedgerFoundationSnapshot,
} from "./material_ledger_foundation.snapshot";

let snapshot: MaterialLedgerFoundationSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as MaterialLedgerFoundationSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("建立确认入库批次和追加式流水，并移除旧数量与库位列", async () => {
    const tables = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name=ANY($1::text[])
        ORDER BY table_name`,
      [["production_material_stock_lot", "production_material_stock_movement"]],
    );
    expect(tables.rows.map(x => x.table_name)).toEqual([
      "production_material_stock_lot", "production_material_stock_movement",
    ]);
    const legacyColumns = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='production_material'
          AND column_name=ANY($1::text[])`,
      [["quantity", "location"]],
    );
    expect(legacyColumns.rows).toEqual([]);
  });
});

describe("integrity verification", () => {
  it.skipIf(!snapshot)("流水不可覆盖或删除，且不能扣成负数", async () => {
    const lotId = `ml_${snapshot!.materialId.replaceAll("-", "")}`;
    const movementId = `mm_test_${Date.now().toString(36)}`;
    await expect(getPool().query(
      `INSERT INTO production_material_stock_movement
         (id, production_id, lot_id, from_bucket, to_bucket, quantity, created_by)
       VALUES ($1,$2,$3,'in_stock','checked_out',8,$4)`,
      [movementId, snapshot!.productionId, lotId, snapshot!.createdBy],
    )).rejects.toThrow(/negative/);
    const migratedId = `mm_${snapshot!.materialId.replaceAll("-", "")}`;
    await expect(getPool().query(
      "UPDATE production_material_stock_movement SET note='改写' WHERE id=$1",
      [migratedId],
    )).rejects.toThrow(/append-only/);
    await expect(getPool().query(
      "DELETE FROM production_material_stock_movement WHERE id=$1", [migratedId],
    )).rejects.toThrow(/append-only/);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("旧物料事实转换为一个已收货批次且定义字段不丢失", async () => {
    const result = await getPool().query<{
      name: string; category: string; notes: string; created_by: string;
      lot_id: string; confirmed_quantity: string; location: string;
      from_bucket: string; to_bucket: string; moved_quantity: string;
    }>(
      `SELECT m.name, m.category, m.notes, m.created_by,
              l.id AS lot_id, l.confirmed_quantity::text, l.location,
              sm.from_bucket, sm.to_bucket, sm.quantity::text AS moved_quantity
         FROM production_material m
         JOIN production_material_stock_lot l ON l.material_id=m.id
         JOIN production_material_stock_movement sm ON sm.lot_id=l.id
        WHERE l.id=$1 AND m.production_id=$2`,
      [`ml_${snapshot!.materialId.replaceAll("-", "")}`, snapshot!.productionId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      name: snapshot!.name,
      category: snapshot!.category,
      notes: snapshot!.notes,
      created_by: snapshot!.createdBy,
      lot_id: `ml_${snapshot!.materialId.replaceAll("-", "")}`,
      confirmed_quantity: `${snapshot!.quantity}.000`,
      location: snapshot!.location,
      from_bucket: "expected",
      to_bucket: "in_stock",
      moved_quantity: `${snapshot!.quantity}.000`,
    });
  });
});
