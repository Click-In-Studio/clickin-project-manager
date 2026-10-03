import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type Snapshot } from "./material_lifecycle.snapshot";
import { getMaterial } from "@/lib/ops/material-db";
let snapshot: Snapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot; } catch { snapshot = null; }

describe("schema verification", () => {
  it("用途历史没有级联删除 FK，库存有状态机触发器与校正余额列", async () => {
    const columns = await getPool().query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='production_material_stock_movement'
      AND column_name=ANY($1::text[])`, [["reason", "exit_reason", "event_id", "event_title", "task_id", "task_title", "source_before", "target_after"]]);
    expect(columns.rows).toHaveLength(8);
    const fks = await getPool().query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='production_material_stock_movement'::regclass AND contype='f'`);
    expect(fks.rows.some(row => /FOREIGN KEY \((event_id|task_id)\)/.test(row.definition))).toBe(false);
    const triggers = await getPool().query(`SELECT 1 FROM pg_trigger WHERE tgrelid='production_material_stock_movement'::regclass
      AND tgname='production_material_a_lifecycle_guard' AND NOT tgisinternal`);
    expect(triggers.rows).toHaveLength(1);
  });
});
describe("integrity verification", () => {
  it.skipIf(!snapshot)("直接 SQL 也不能非法跳转或覆盖历史流水", async () => {
    await expect(getPool().query(`INSERT INTO production_material_stock_movement
      (id,production_id,lot_id,from_bucket,to_bucket,quantity,created_by)
      VALUES ($1,$2,$3,'in_stock','expected',1,$4)`, [`mm_bad_${snapshot!.lotId}`, snapshot!.productionId, snapshot!.lotId, snapshot!.createdBy]))
      .rejects.toThrow(/illegal material transition/);
    await expect(getPool().query("UPDATE production_material_stock_movement SET quantity=1 WHERE id=$1", [snapshot!.movementId]))
      .rejects.toThrow(/append-only/);
  });
});
describe("invariance verification", () => {
  it.skipIf(!snapshot)("历史入库数量、操作者和时间完全保留，不伪造新快照", async () => {
    const { rows: [row] } = await getPool().query(`SELECT lot_id,quantity::text,created_by,created_at,note,source_before,event_id
      FROM production_material_stock_movement WHERE id=$1`, [snapshot!.movementId]);
    expect(row).toMatchObject({ lot_id: snapshot!.lotId, quantity: "4.000", created_by: snapshot!.createdBy,
      note: "历史入库", source_before: null, event_id: null });
    expect(row.created_at.toISOString()).toBe(snapshot!.createdAt);
    expect(await getMaterial(snapshot!.materialId, snapshot!.productionId)).toMatchObject({ inStockQuantity: 4, expectedQuantity: 0 });
  });
});
