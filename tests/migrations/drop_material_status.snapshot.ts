import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "drop-material-status-snapshot.json");

export type DropMaterialStatusSnapshot = {
  productionId: string;
  material: {
    id: string;
    code: string;
    name: string;
    category: string;
    notes: string;
    createdBy: string;
  };
};

export const createPreMigrationData: MigrationHook<DropMaterialStatusSnapshot>["createPreMigrationData"] =
  async ({ pool, faker, testOwner }) => {
    const suffix = faker.string.alphanumeric(10).toLowerCase();
    const productionId = `statuscontract-${suffix}`;
    await pool.query(
      "INSERT INTO production (id, name, owner_id) VALUES ($1, '物料状态退役迁移', $2)",
      [productionId, testOwner],
    );
    const viewId = `sv_status_contract_${suffix}`;
    await pool.query(
      "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
      [viewId, productionId],
    );
    await pool.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [
      viewId,
      productionId,
    ]);

    const { rows: [status] } = await pool.query<{ id: string }>(
      `INSERT INTO production_material_status (production_id, name, color, order_index)
       VALUES ($1, '历史自定义状态', '#123456', 7)
       RETURNING id`,
      [productionId],
    );
    const code = `STATUS-${suffix}`;
    const { rows: [material] } = await pool.query<{
      id: string;
      code: string;
      name: string;
      category: string;
      notes: string;
      created_by: string;
    }>(
      `INSERT INTO production_material
         (production_id, code, name, category, status_id, notes, created_by)
       VALUES ($1, $2, '历史物料', '道具', $3, '保留的备注', $4)
       RETURNING id, code, name, category, notes, created_by`,
      [productionId, code, status.id, testOwner],
    );

    return {
      productionId,
      material: {
        id: material.id,
        code: material.code,
        name: material.name,
        category: material.category,
        notes: material.notes,
        createdBy: material.created_by,
      },
    };
  };

export const cleanup: MigrationHook<DropMaterialStatusSnapshot>["cleanup"] =
  async (pool, snapshot) => {
    await pool.query("DELETE FROM production WHERE id = $1", [snapshot.productionId]);
  };
