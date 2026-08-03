import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/pg";
import { faker } from "@faker-js/faker";
import {
  isPreMigrationSchema,
  createPreMigrationData,
  SNAPSHOT_PATH,
  type PreMigrationSnapshot,
} from "./migration-snapshot";
import {
  isCueListRolePreMigrationSchema,
  createCueListRolePreMigrationData,
  CUE_LIST_ROLE_SNAPSHOT_PATH,
  type CueListRoleSnapshot,
} from "./cue-list-role-snapshot";
import {
  isMemberRolesPreMigrationSchema,
  createMemberRolesPreMigrationData,
  MEMBER_ROLES_SNAPSHOT_PATH,
  type MemberRolesSnapshot,
} from "./member-roles-snapshot";
import {
  isDeptPocCleanupPreMigrationSchema,
  createDeptPocCleanupPreMigrationData,
  DEPT_POC_CLEANUP_SNAPSHOT_PATH,
  type DeptPocCleanupSnapshot,
} from "./dept-poc-cleanup-snapshot";

// Fixed UUID for the test system user — must match TEST_USER in helpers.ts
const TEST_USER = "00000000-0000-0000-0000-000000000001";

export async function setup() {
  // Generate deterministic TEST_SEED for faker (workers inherit process.env).
  if (!process.env.TEST_SEED) {
    process.env.TEST_SEED = String(Math.floor(Math.random() * 0xffff_ffff));
  }
  console.log(
    `\nTest seed: ${process.env.TEST_SEED}  (reproduce: TEST_SEED=${process.env.TEST_SEED} npm test)\n`,
  );

  const pool = getPool();

  if (await isPreMigrationSchema(pool)) {
    // Migration path: DB is on the old schema (pre-internal-user-id).
    faker.seed(Number(process.env.TEST_SEED));
    const snapshot = await createPreMigrationData(pool, faker);
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-internal-user-id.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // Insert the test system user (always runs on post-internal-user-id schema).
  // app_user must exist before feishu_user (FK: feishu_user.user_id → app_user.id).
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ('test-sys-feishu', $1, '测试系统用户', FALSE, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );

  if (await isCueListRolePreMigrationSchema(pool)) {
    // Migration path: DB has default_edit_roles column (pre-cue-list-role).
    // TEST_USER already inserted above; use it as creator for factory rows.
    const cueListRoleSnapshot = await createCueListRolePreMigrationData(pool, TEST_USER);
    await writeFile(CUE_LIST_ROLE_SNAPSHOT_PATH, JSON.stringify(cueListRoleSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-cue-list-role.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isMemberRolesPreMigrationSchema(pool)) {
    // Migration path: production_member_role table doesn't exist yet.
    // TEST_USER already inserted above; use it as the factory member.
    const memberRolesSnapshot = await createMemberRolesPreMigrationData(pool, TEST_USER);
    await writeFile(MEMBER_ROLES_SNAPSHOT_PATH, JSON.stringify(memberRolesSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-member-roles.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  if (await isDeptPocCleanupPreMigrationSchema(pool)) {
    // Migration path: poc_block_write_from_children column still exists.
    // TEST_USER already inserted above; use it as the factory dept member.
    const deptPocSnapshot = await createDeptPocCleanupPreMigrationData(pool, TEST_USER);
    await writeFile(DEPT_POC_CLEANUP_SNAPSHOT_PATH, JSON.stringify(deptPocSnapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-dept-member-poc-cleanup.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }
}

export async function teardown() {
  const pool = getPool();

  // Tables with no ON DELETE CASCADE from app_user:
  // cue_list.created_by and production_event.created_by need explicit deletes first.
  await pool.query("DELETE FROM cue_list WHERE created_by = $1", [TEST_USER]);
  await pool.query("DELETE FROM production_event WHERE created_by = $1", [TEST_USER]);

  // Clean up dept-poc-cleanup migration factory data (migration path only; no-op otherwise).
  let deptPocCleanupSnapshot: DeptPocCleanupSnapshot | null = null;
  try {
    deptPocCleanupSnapshot = JSON.parse(
      await readFile(DEPT_POC_CLEANUP_SNAPSHOT_PATH, "utf8"),
    ) as DeptPocCleanupSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (deptPocCleanupSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [deptPocCleanupSnapshot.production.id],
    ).catch(() => {});
    await unlink(DEPT_POC_CLEANUP_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up member-roles migration factory data (migration path only; no-op otherwise).
  let memberRolesSnapshot: MemberRolesSnapshot | null = null;
  try {
    memberRolesSnapshot = JSON.parse(
      await readFile(MEMBER_ROLES_SNAPSHOT_PATH, "utf8"),
    ) as MemberRolesSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (memberRolesSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [memberRolesSnapshot.production.id],
    ).catch(() => {});
    await unlink(MEMBER_ROLES_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up cue-list-role migration factory data (migration path only; no-op otherwise).
  let cueListRoleSnapshot: CueListRoleSnapshot | null = null;
  try {
    cueListRoleSnapshot = JSON.parse(
      await readFile(CUE_LIST_ROLE_SNAPSHOT_PATH, "utf8"),
    ) as CueListRoleSnapshot;
  } catch {
    // Normal path: no snapshot file.
  }
  if (cueListRoleSnapshot) {
    await pool.query(
      "DELETE FROM production WHERE id = $1",
      [cueListRoleSnapshot.production.id],
    ).catch(() => {});
    await unlink(CUE_LIST_ROLE_SNAPSHOT_PATH).catch(() => {});
  }

  // Clean up internal-user-id migration factory data (migration path only; no-ops otherwise).
  let snapshot: PreMigrationSnapshot | null = null;
  try {
    snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as PreMigrationSnapshot;
  } catch {
    // Normal path: no snapshot file, nothing to clean up.
  }
  if (snapshot) {
    // DELETE FROM production cascades to production_member, cue_list, production_event, comment.
    await pool.query("DELETE FROM production WHERE id = $1", [snapshot.production.id]).catch(() => {});
    // Delete app_user records created by migration for the factory users; cascades to feishu_user.
    const openIds = snapshot.users.map((u) => u.openId);
    await pool.query(
      "DELETE FROM app_user WHERE id IN (SELECT user_id FROM feishu_user WHERE open_id = ANY($1))",
      [openIds],
    ).catch(() => {});
    await unlink(SNAPSHOT_PATH).catch(() => {});
  }

  // Deleting app_user cascades to feishu_user, production_member, comment, etc.
  await pool.query("DELETE FROM app_user WHERE id = $1", [TEST_USER]);
  await pool.end();
}
