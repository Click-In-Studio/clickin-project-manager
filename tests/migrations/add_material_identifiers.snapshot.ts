import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "add-material-identifiers-snapshot.json");

export type AddMaterialIdentifiersSnapshot = {
  productionId: string;
  oldMaterialId: string;
  lotId: string;
  name: string;
  oldCode: string;
  createdBy: string;
};

export const createPreMigrationData: MigrationHook<AddMaterialIdentifiersSnapshot>["createPreMigrationData"] =
  async ({ pool, faker, testOwner }) => {
    const suffix = faker.string.alphanumeric(10).toLowerCase();
    const productionId = `material-identifiers-${suffix}`;
    await pool.query(
      "INSERT INTO production (id, name, owner_id) VALUES ($1, '物料编号迁移', $2)",
      [productionId, testOwner],
    );
    const viewId = `sv_material_identifiers_${suffix}`;
    await pool.query(
      "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
      [viewId, productionId],
    );
    await pool.query("UPDATE production SET master_view_id=$1 WHERE id=$2", [viewId, productionId]);
    const oldCode = `OLD-${suffix}`;
    const { rows: [material] } = await pool.query<{ id: string }>(
      `INSERT INTO production_material
         (production_id, code, name, category, tracking_strategy, created_by)
       VALUES ($1,$2,'迁移前无线话筒','设备','serialized',$3)
       RETURNING id`,
      [productionId, oldCode, testOwner],
    );
    const lotId = `ml_identifier_${suffix}`;
    await pool.query(
      `INSERT INTO production_material_stock_lot
         (id, production_id, material_id, confirmed_quantity, location, created_by)
       VALUES ($1,$2,$3,1,'设备库',$4)`,
      [lotId, productionId, material.id, testOwner],
    );
    await pool.query(
      `INSERT INTO production_material_stock_movement
         (id, production_id, lot_id, from_bucket, to_bucket, quantity, created_by)
       VALUES ($1,$2,$3,'expected','in_stock',1,$4)`,
      [`mm_identifier_${suffix}`, productionId, lotId, testOwner],
    );
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source)
       VALUES ($1,$2,'material',$3,'*','edit','migrated')`,
      [productionId, testOwner, material.id],
    );
    return {
      productionId, oldMaterialId: material.id, lotId,
      name: "迁移前无线话筒", oldCode, createdBy: testOwner,
    };
  };

export const cleanup: MigrationHook<AddMaterialIdentifiersSnapshot>["cleanup"] =
  async (pool, snapshot) => {
    await pool.query("DELETE FROM production WHERE id=$1", [snapshot.productionId]);
  };
