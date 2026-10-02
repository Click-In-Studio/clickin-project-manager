import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "material-source-rentals-snapshot.json");

export type MaterialSourceRentalsSnapshot = {
  productionId: string;
  materialId: string;
  lotId: string;
  receiptId: string;
  createdBy: string;
  receiptCreatedAt: string;
};

export const createPreMigrationData:
MigrationHook<MaterialSourceRentalsSnapshot>["createPreMigrationData"] = async ({
  pool, faker, testOwner,
}) => {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query(
    "INSERT INTO production (id, name, owner_id) VALUES ($1,$2,$3)",
    [productionId, "物料来源迁移", testOwner],
  );
  const viewId = `sv_ms_${faker.string.alphanumeric(8).toLowerCase()}`;
  await pool.query(
    "INSERT INTO script_view (id, production_id, name) VALUES ($1,$2,'标准本')",
    [viewId, productionId],
  );
  await pool.query("UPDATE production SET master_view_id=$1 WHERE id=$2", [viewId, productionId]);

  const material = await pool.query<{ id: string }>(
    `INSERT INTO production_material
       (production_id, code, name, category, tracking_strategy, unit, quantity_scale,
        notes, created_by)
     VALUES ($1,$2,'旧来源物料','设备','bulk_returnable','件',0,'迁移保留',$3)
     RETURNING id`,
    [productionId, `MS-${faker.string.alphanumeric(6)}`, testOwner],
  );
  const suffix = faker.string.alphanumeric(10).toLowerCase();
  const lotId = `ml_ms_${suffix}`;
  const receiptId = `mm_ms_${suffix}`;
  await pool.query(
    `INSERT INTO production_material_stock_lot
       (id, production_id, material_id, confirmed_quantity, location, created_by)
     VALUES ($1,$2,$3,4,'设备库',$4)`,
    [lotId, productionId, material.rows[0].id, testOwner],
  );
  const receipt = await pool.query<{ created_at: Date }>(
    `INSERT INTO production_material_stock_movement
       (id, production_id, lot_id, from_bucket, to_bucket, quantity, created_by)
     VALUES ($1,$2,$3,'expected','in_stock',4,$4)
     RETURNING created_at`,
    [receiptId, productionId, lotId, testOwner],
  );
  return {
    productionId, materialId: material.rows[0].id, lotId, receiptId,
    createdBy: testOwner, receiptCreatedAt: receipt.rows[0].created_at.toISOString(),
  };
};

export const cleanup: MigrationHook<MaterialSourceRentalsSnapshot>["cleanup"] =
  async (pool, snapshot) => {
    await pool.query("DELETE FROM production WHERE id=$1", [snapshot.productionId]);
  };

