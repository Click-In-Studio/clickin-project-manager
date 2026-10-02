import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "material-ledger-foundation-snapshot.json");

export type MaterialLedgerFoundationSnapshot = {
  productionId: string;
  materialId: string;
  code: string;
  name: string;
  category: string;
  location: string;
  quantity: number;
  notes: string;
  createdBy: string;
};

export const createPreMigrationData:
MigrationHook<MaterialLedgerFoundationSnapshot>["createPreMigrationData"] = async ({
  pool, faker, testOwner,
}) => {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query(
    "INSERT INTO production (id, name, owner_id) VALUES ($1,$2,$3)",
    [productionId, "物料流水迁移", testOwner],
  );
  const viewId = `sv_mat_${faker.string.alphanumeric(8).toLowerCase()}`;
  await pool.query(
    "INSERT INTO script_view (id, production_id, name) VALUES ($1,$2,'标准本')",
    [viewId, productionId],
  );
  await pool.query("UPDATE production SET master_view_id=$1 WHERE id=$2", [viewId, productionId]);

  const code = `LEGACY-${faker.string.alphanumeric(6)}`;
  const name = "旧台账无线话筒";
  const category = "设备";
  const location = "设备库 A-03";
  const quantity = 7;
  const notes = "保留的旧备注";
  const material = await pool.query<{ id: string }>(
    `INSERT INTO production_material
       (production_id, code, name, category, location, quantity, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [productionId, code, name, category, location, quantity, notes, testOwner],
  );
  return {
    productionId, materialId: material.rows[0].id, code, name, category,
    location, quantity, notes, createdBy: testOwner,
  };
};

export const cleanup: MigrationHook<MaterialLedgerFoundationSnapshot>["cleanup"] =
  async (pool, snapshot) => {
    await pool.query("DELETE FROM production WHERE id=$1", [snapshot.productionId]);
  };
