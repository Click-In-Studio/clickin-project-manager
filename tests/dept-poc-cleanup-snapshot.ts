/**
 * Pre-migration snapshot for migrate-dept-member-poc-cleanup invariance tests.
 *
 * isMigrationNeeded: true when poc_block_write_from_children column exists.
 * createPreMigrationData: inserts a dept member row, captures column values that
 *   must survive the DROP COLUMN.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const DEPT_POC_CLEANUP_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "dept-poc-cleanup-migration-snapshot.json",
);

export type DeptPocCleanupSnapshot = {
  production: { id: string };
  deptMember: {
    userId: string;
    deptId: string;
    isPoc: boolean;
    pocExtraPermissions: string[];
    pocBlockedPermissions: string[];
  };
};

export async function isDeptPocCleanupPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'production_dept_member'
      AND column_name = 'poc_block_write_from_children'
  `);
  return rows.length > 0;
}

export async function createDeptPocCleanupPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<DeptPocCleanupSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;

  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    prodId,
    faker.company.name(),
  ]);
  await pool.query(
    "INSERT INTO version (id, production_id, label, created_at) VALUES ($1, $2, $3, NOW())",
    [`${prodId}_v1`, prodId, "initial"],
  );
  await pool.query("UPDATE production SET active_version_id = $1 WHERE id = $2", [
    `${prodId}_v1`,
    prodId,
  ]);

  const { rows: deptRows } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id",
    [prodId, "测试部门"],
  );
  const deptId = deptRows[0].id;

  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles)
     VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING`,
    [prodId, testUserId],
  );

  const pocExtraPermissions = ["cue_list:edit"];
  const pocBlockedPermissions = ["cue_list:delete"];

  await pool.query(
    `INSERT INTO production_dept_member
       (production_id, user_id, dept_id, is_poc, poc_extra_permissions,
        poc_blocked_permissions, poc_block_write_from_children)
     VALUES ($1, $2, $3, true, $4, $5, false)`,
    [prodId, testUserId, deptId, pocExtraPermissions, pocBlockedPermissions],
  );

  return {
    production: { id: prodId },
    deptMember: {
      userId: testUserId,
      deptId,
      isPoc: true,
      pocExtraPermissions,
      pocBlockedPermissions,
    },
  };
}
