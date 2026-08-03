/**
 * Pre-migration snapshot for migrate-cue-list-to-resource-grant invariance tests.
 *
 * isCueListGrantPreMigrationSchema: true when cue_list_permission table still exists.
 *
 * createCueListGrantPreMigrationData: inserts:
 *   - A cue list with creator having can_edit=true in cue_list_permission
 *   - A second user with can_edit=true via cue_list_permission (personal grant)
 *   - A role in cue_list_role, with a third user having that role in production_member
 *
 * Invariance test verifies that after migration all three users have active
 * resource_grant rows for that cue list, and that cue_list_permission /
 * cue_list_role tables no longer exist.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const CUE_LIST_GRANT_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "cue-list-grant-migration-snapshot.json",
);

export type CueListGrantSnapshot = {
  production: { id: string };
  cueList: { id: string; creatorId: string };
  personalGrantUserId: string;
  roleGrantUserId: string;
  roleName: string;
};

/** Returns true if cue_list_permission table still exists (migration not yet run). */
export async function isCueListGrantPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cue_list_permission'
  `);
  return rows.length > 0;
}

export async function createCueListGrantPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<CueListGrantSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const cueListId = `cl_${faker.string.alphanumeric(8).toLowerCase()}`;

  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    prodId,
    faker.company.name(),
  ]);
  await pool.query(
    "INSERT INTO version (id, production_id, label, created_at) VALUES ($1, $2, $3, NOW())",
    [`${prodId}_v1`, prodId, "initial"],
  );
  await pool.query("UPDATE production SET active_version_id = $1 WHERE id = $2", [
    `${prodId}_v1`, prodId,
  ]);

  // Creator = TEST_USER
  await pool.query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [prodId, testUserId],
  );

  // Create second user (personal grant user) — use a deterministic UUID
  const personalGrantUserId = "00000000-0000-0000-0000-000000000002";
  await pool.query(
    "INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING",
    [personalGrantUserId],
  );
  await pool.query(
    "INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at) VALUES ($1, $2, $3, FALSE, NOW(), NOW()) ON CONFLICT DO NOTHING",
    [`test-personal-${faker.string.alphanumeric(4)}`, personalGrantUserId, "个人授权用户"],
  );
  await pool.query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [prodId, personalGrantUserId],
  );

  // Create third user (role-based grant user) — use a deterministic UUID
  const roleGrantUserId = "00000000-0000-0000-0000-000000000003";
  await pool.query(
    "INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING",
    [roleGrantUserId],
  );
  await pool.query(
    "INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at) VALUES ($1, $2, $3, FALSE, NOW(), NOW()) ON CONFLICT DO NOTHING",
    [`test-role-${faker.string.alphanumeric(4)}`, roleGrantUserId, "角色授权用户"],
  );
  const roleName = "灯光设计";
  await pool.query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [prodId, roleGrantUserId, [roleName]],
  );

  // Create cue list
  await pool.query(
    `INSERT INTO cue_list (id, production_id, name, notes, created_by)
     VALUES ($1, $2, '测试灯光表', '', $3)`,
    [cueListId, prodId, testUserId],
  );

  // Creator gets can_edit via cue_list_permission
  await pool.query(
    "INSERT INTO cue_list_permission (cue_list_id, user_id, can_edit) VALUES ($1, $2, true) ON CONFLICT DO NOTHING",
    [cueListId, testUserId],
  );

  // Second user gets personal can_edit
  await pool.query(
    "INSERT INTO cue_list_permission (cue_list_id, user_id, can_edit) VALUES ($1, $2, true) ON CONFLICT DO NOTHING",
    [cueListId, personalGrantUserId],
  );

  // Create production_role + cue_list_role for third user
  const roleId = `r_${prodId}_灯光`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [roleId, prodId, roleName],
  );
  await pool.query(
    "INSERT INTO cue_list_role (cue_list_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [cueListId, roleId],
  );

  return {
    production: { id: prodId },
    cueList: { id: cueListId, creatorId: testUserId },
    personalGrantUserId,
    roleGrantUserId,
    roleName,
  };
}
