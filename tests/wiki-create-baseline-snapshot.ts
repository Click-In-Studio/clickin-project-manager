/**
 * Pre-migration snapshot for migrate-wiki-create-baseline invariance tests.
 *
 * isMigrationNeeded: 存在未持有 'node:wiki/*@create' 的非弃用 role
 *  （已迁移库全部 role 有该行；新建 role 经 seedRoleFromTemplate '*' 基线获得）。
 * createPreMigrationData: 造一个不带该键的 role（存量形态）。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const WIKI_CREATE_BASELINE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "wiki-create-baseline-migration-snapshot.json",
);

export type WikiCreateBaselineSnapshot = {
  prodId: string;
  roleId: string;
};

export async function isWikiCreateBaselinePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM production_role r
    WHERE NOT r.is_deprecated
      AND NOT EXISTS (
        SELECT 1 FROM production_role_permission prp
        WHERE prp.role_id = r.id AND prp.permission_key = 'node:wiki/*@create'
      )
    LIMIT 1
  `);
  return rows.length > 0;
}

export async function createWikiCreateBaselinePreMigrationData(
  pool: Pool,
): Promise<WikiCreateBaselineSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    prodId, faker.company.name(),
  ]);
  const roleId = `role${faker.string.alphanumeric(8).toLowerCase()}`;
  await pool.query(
    `INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, '存量工厂角色')`,
    [roleId, prodId],
  );
  return { prodId, roleId };
}
