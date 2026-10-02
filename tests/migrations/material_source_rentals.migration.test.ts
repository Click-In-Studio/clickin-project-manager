import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH, type MaterialSourceRentalsSnapshot,
} from "./material_source_rentals.snapshot";

let snapshot: MaterialSourceRentalsSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as MaterialSourceRentalsSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("批次具有来源快照和归还义务，实际事件使用追加表与发生时间", async () => {
    const columns = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND ((table_name='production_material_stock_lot'
                AND column_name=ANY($1::text[]))
            OR (table_name='production_material_stock_movement' AND column_name='occurred_at'))
        ORDER BY table_name, column_name`,
      [["source_type", "source_label", "source_reference", "source_note",
        "expected_arrival_at", "return_due_at", "return_due_quantity"]],
    );
    expect(columns.rows).toHaveLength(8);
    const tables = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name=ANY($1::text[])
        ORDER BY table_name`,
      [["production_material_source_return", "production_material_source_exception"]],
    );
    expect(tables.rows.map(row => row.table_name)).toEqual([
      "production_material_source_exception", "production_material_source_return",
    ]);
  });
});

describe("integrity verification", () => {
  it.skipIf(!snapshot)("非租借批次不能携带归还义务，来源历史不可覆盖", async () => {
    await expect(getPool().query(
      `INSERT INTO production_material_stock_lot
         (id, production_id, material_id, confirmed_quantity, source_type,
          return_due_quantity, created_by)
       VALUES ($1,$2,$3,1,'purchased',1,$4)`,
      [`ml_bad_${Date.now().toString(36)}`, snapshot!.productionId,
        snapshot!.materialId, snapshot!.createdBy],
    )).rejects.toThrow(/material_stock_lot_return_obligation_check/);
    await expect(getPool().query(
      "UPDATE production_material_stock_lot SET source_label='改写' WHERE id=$1",
      [snapshot!.lotId],
    )).rejects.toThrow(/append-only/);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("旧批次回填为既有来源，流水发生时间与原创建时间一致", async () => {
    const result = await getPool().query<{
      source_type: string; source_label: string; return_due_quantity: string | null;
      confirmed_quantity: string; quantity: string; occurred_at: Date; created_at: Date;
    }>(
      `SELECT lot.source_type, lot.source_label, lot.return_due_quantity::text,
              lot.confirmed_quantity::text, movement.quantity::text,
              movement.occurred_at, movement.created_at
         FROM production_material_stock_lot lot
         JOIN production_material_stock_movement movement ON movement.id=$2
        WHERE lot.id=$1`,
      [snapshot!.lotId, snapshot!.receiptId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      source_type: "existing", source_label: "", return_due_quantity: null,
      confirmed_quantity: "4.000", quantity: "4.000",
    });
    expect(result.rows[0].created_at.toISOString()).toBe(snapshot!.receiptCreatedAt);
    expect(result.rows[0].occurred_at.toISOString()).toBe(snapshot!.receiptCreatedAt);
  });
});

