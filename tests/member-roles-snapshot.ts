/**
 * Pre-migration snapshot for migrate-member-roles invariance tests.
 *
 * isMemberRolesPreMigrationSchema: true when production_member_role table doesn't exist yet.
 * createMemberRolesPreMigrationData: inserts a production member with roles TEXT[] on old schema.
 * global-setup.ts calls this before applying the migration, then saves the snapshot.
 *
 * After migration, member-roles.migration.test.ts reads the snapshot and verifies that
 * each role name in roles[] maps to a production_member_role row.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const MEMBER_ROLES_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "member-roles-migration-snapshot.json",
);

export type MemberRolesSnapshot = {
  production: { id: string };
  member: {
    userId: string;
    roles: string[];  // role names that should appear in production_member_role post-migration
  };
};

export async function isMemberRolesPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'production_member_role'
  `);
  return rows.length === 0;
}

export async function createMemberRolesPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<MemberRolesSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;

  // Create production (seeds production_role via seedProductionRoles)
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [prodId, faker.company.name(), testUserId]);
  await pool.query(
    "INSERT INTO version (id, production_id, name, created_at) VALUES ($1, $2, $3, NOW())",
    [`${prodId}_v1`, prodId, "initial"],
  );
  await pool.query(
    "UPDATE production SET active_version_id = $1 WHERE id = $2",
    [`${prodId}_v1`, prodId],
  );

  // Seed production_role from templates (replicates seedProductionRoles minimal path)
  const roleNames = ["编剧", "导演"];
  for (const name of roleNames) {
    const roleId = `r_${prodId}_${encodeURIComponent(name)}`;
    await pool.query(
      `INSERT INTO production_role (id, production_id, name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [roleId, prodId, name],
    );
  }

  // Add member with roles TEXT[]
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [prodId, testUserId, roleNames],
  );

  return {
    production: { id: prodId },
    member: { userId: testUserId, roles: roleNames },
  };
}
