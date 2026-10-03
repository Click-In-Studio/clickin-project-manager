import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "material-lifecycle-snapshot.json");
export type Snapshot = { productionId: string; materialId: string; lotId: string; movementId: string; createdBy: string; createdAt: string };
export const createPreMigrationData: MigrationHook<Snapshot>["createPreMigrationData"] = async ({ pool, faker, testOwner }) => {
  const suffix = faker.string.alphanumeric(10).toLowerCase();
  const productionId = `t${suffix}`;
  await pool.query("INSERT INTO production (id,name,owner_id) VALUES ($1,'流转迁移',$2)", [productionId, testOwner]);
  const viewId = `sv_lc_${suffix}`;
  await pool.query("INSERT INTO script_view (id,production_id,name) VALUES ($1,$2,'标准本')", [viewId, productionId]);
  await pool.query("UPDATE production SET master_view_id=$1 WHERE id=$2", [viewId, productionId]);
  const { rows: [material] } = await pool.query<{ id: string }>(`INSERT INTO production_material
    (production_id,code,name,created_by) VALUES ($1,$2,'历史道具',$3) RETURNING id`, [productionId, `LC-${suffix}`, testOwner]);
  const lotId = `ml_lc_${suffix}`, movementId = `mm_lc_${suffix}`;
  await pool.query(`INSERT INTO production_material_stock_lot (id,production_id,material_id,confirmed_quantity,location,created_by)
    VALUES ($1,$2,$3,4,'旧仓库',$4)`, [lotId, productionId, material.id, testOwner]);
  const { rows: [movement] } = await pool.query<{ created_at: Date }>(`INSERT INTO production_material_stock_movement
    (id,production_id,lot_id,from_bucket,to_bucket,quantity,created_by,note)
    VALUES ($1,$2,$3,'expected','in_stock',4,$4,'历史入库') RETURNING created_at`, [movementId, productionId, lotId, testOwner]);
  return { productionId, materialId: material.id, lotId, movementId, createdBy: testOwner, createdAt: movement.created_at.toISOString() };
};
export const cleanup: MigrationHook<Snapshot>["cleanup"] = async (pool, snapshot) => {
  await pool.query("DELETE FROM production WHERE id=$1", [snapshot.productionId]);
};
