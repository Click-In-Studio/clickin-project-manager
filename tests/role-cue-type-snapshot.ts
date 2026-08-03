/**
 * Pre-migration snapshot for migrate-role-cue-type-to-dept invariance tests.
 *
 * isRoleCueTypePreMigrationSchema: true when production_role_cue_type table still exists.
 *
 * createRoleCueTypePreMigrationData: inserts a production_role with a cue_type entry,
 *   a dept, and a member with that role — so the migration can auto-map the cue_type
 *   to the dept's allowed_cue_types.
 *
 * Invariance test verifies that after migration:
 *   - The dept's allowed_cue_types contains the cue_type from production_role_cue_type.
 *   - production_role_cue_type table no longer exists.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const ROLE_CUE_TYPE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "role-cue-type-migration-snapshot.json",
);

export type RoleCueTypeSnapshot = {
  production: { id: string };
  role: { id: string; name: string };
  dept: { id: string };
  cueType: string;
  userId: string;
};

/** Returns true if production_role_cue_type table still exists (migration not yet run). */
export async function isRoleCueTypePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'production_role_cue_type'
  `);
  return rows.length > 0;
}

export async function createRoleCueTypePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<RoleCueTypeSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const roleId = `r_${prodId}_灯光设计`;
  const cueType = `灯光`;

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

  // Create production_member with the role
  await pool.query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [prodId, testUserId, ["灯光设计"]],
  );

  // Create production_role + cue_type entry
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [roleId, prodId, "灯光设计"],
  );
  await pool.query(
    "INSERT INTO production_role_cue_type (role_id, cue_type) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [roleId, cueType],
  );

  // Create department
  const deptRes = await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name, display_order, permissions, allowed_cue_types, poc_extra_permissions)
     VALUES ($1, $2, 1, '{}', '{}', '{}') RETURNING id`,
    [prodId, "灯光组"],
  );
  const deptId = deptRes.rows[0].id;

  // Add member to dept
  await pool.query(
    "INSERT INTO production_dept_member (dept_id, production_id, user_id, is_poc, poc_extra_permissions, poc_blocked_permissions) VALUES ($1, $2, $3, false, '{}', '{}') ON CONFLICT DO NOTHING",
    [deptId, prodId, testUserId],
  );

  return {
    production: { id: prodId },
    role: { id: roleId, name: "灯光设计" },
    dept: { id: deptId },
    cueType,
    userId: testUserId,
  };
}
