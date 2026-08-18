/**
 * Pre-migration snapshot for migrate-script-rest invariance（批E PR-E2）.
 * PRE 判据：Permission 词汇表无 'script' 类型行（迁移建词汇），
 * 但更稳的 schema 事实：atomic 表允许 script:% 且词汇 script 行不存在。
 * 用词汇 ('script','view') 不存在作为 PRE 判据。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const SCRIPT_REST_SNAPSHOT_PATH = path.join(os.tmpdir(), "script-rest-migration-snapshot.json");

export type ScriptRestSnapshot = {
  productionId: string;
  editUserId: string;      // script:edit bundle 持有者
  annotateUserId: string;  // script:annotate bundle 持有者
  importUserId: string;    // script:import + dramaturgy:import
  roleId: string;
};

export async function isScriptRestPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level
     WHERE resource_type = 'script' AND permission_level = 'view'`,
  );
  return rows.length === 0;
}

async function makeUser(pool: Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO app_user (created_at) VALUES (NOW()) RETURNING id",
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, NOW(), NOW())`,
    [`test-sr-${faker.string.alphanumeric(10)}`, rows[0].id, name],
  );
  return rows[0].id;
}

export async function createScriptRestPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<ScriptRestSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    productionId, `批E2迁移工厂-${faker.string.alphanumeric(4)}`, testUserId,
  ]);

  const editUserId = await makeUser(pool, "批E2-edit");
  const annotateUserId = await makeUser(pool, "批E2-annotate");
  const importUserId = await makeUser(pool, "批E2-import");

  await pool.query(
    `INSERT INTO atomic_permission_grant
       (production_id, user_id, permission_key, grant_source, confirmed_by)
     VALUES ($1, $2, 'script:edit',       'self_confirmed', $2),
            ($1, $3, 'script:annotate',   'self_confirmed', $3),
            ($1, $4, 'script:import',     'self_confirmed', $4),
            ($1, $4, 'dramaturgy:import', 'self_confirmed', $4)`,
    [productionId, editUserId, annotateUserId, importUserId],
  );

  const roleId = `role_sr_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
    [roleId, productionId, `批E2角色${faker.string.alphanumeric(4)}`],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'script:view'), ($1, 'script:comment'), ($1, 'script:manage'),
            ($1, 'rehearsal_mark:move')`,
    [roleId],
  );

  return { productionId, editUserId, annotateUserId, importUserId, roleId };
}
