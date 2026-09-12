/**
 * Pre-migration snapshot for migrate-cue-list-role invariance tests.
 *
 * createCueListRolePreMigrationData inserts factory rows on the OLD schema
 * (cue_list has default_edit_roles TEXT[], cue_list_role table does not exist).
 * global-setup.ts calls this before applying the migration, then saves the
 * returned snapshot to CUE_LIST_ROLE_SNAPSHOT_PATH.
 *
 * After migration, cue-list-role.migration.test.ts reads the snapshot and
 * verifies that every role name in default_edit_roles maps to a cue_list_role
 * row, and that the creator appears in cue_list_permission.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";

export const CUE_LIST_ROLE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "cue-list-role-migration-snapshot.json",
);

export type CueListRoleSnapshot = {
  production: { id: string };
  cueList: {
    id: string;
    creatorId: string;
    defaultEditRoles: string[];
  };
};

/** Returns true if the DB is still on the pre-migration schema. */
export async function isCueListRolePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cue_list' AND column_name = 'default_edit_roles'
  `);
  return rows.length > 0;
}

/**
 * Inserts factory rows on the OLD schema and returns a snapshot.
 * Must be called BEFORE the migration SQL runs.
 * Uses TEST_USER (a known UUID inserted by global-setup) as creator.
 */
export async function createCueListRolePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<CueListRoleSnapshot> {
  const productionId = `clr-test-${Math.random().toString(36).slice(2, 8)}`;
  const cueListId = `clr-cl-${Math.random().toString(36).slice(2, 8)}`;
  const defaultEditRoles = ["灯光设计", "灯光设计助理"];

  await pool.query(
    `INSERT INTO production (id, name, owner_id) VALUES ($1, '迁移测试演出', $2)`,
    [productionId, testUserId],
  );
  // Use raw INSERT with old schema column (default_edit_roles still exists)
  await pool.query(
    `INSERT INTO cue_list (id, production_id, name, notes, default_edit_roles, created_by)
     VALUES ($1, $2, '灯光走位表', '', $3, $4)`,
    [cueListId, productionId, defaultEditRoles, testUserId],
  );

  return {
    production: { id: productionId },
    cueList: { id: cueListId, creatorId: testUserId, defaultEditRoles },
  };
}
