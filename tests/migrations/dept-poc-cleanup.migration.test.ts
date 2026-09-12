/**
 * Migration tests for migrate-dept-member-poc-cleanup.sql.
 *
 * Operating modes:
 *
 *   Migration path (CI: schema before poc-cleanup migration):
 *     global-setup.ts detects poc_block_write_from_children column, inserts
 *     a factory dept member row, applies the migration, writes snapshot to
 *     DEPT_POC_CLEANUP_SNAPSHOT_PATH. All three layers run.
 *
 *   Normal path (already-migrated DB):
 *     Snapshot file does not exist. Schema and integrity layers run;
 *     invariance skips (it.skipIf).
 *
 * Layer structure:
 *   1. Schema    — column absence, surviving column types, index presence
 *   2. Integrity — no orphan FK references
 *   3. Invariance — factory row's surviving column values unchanged post-migration
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  DEPT_POC_CLEANUP_SNAPSHOT_PATH,
  type DeptPocCleanupSnapshot,
} from "./dept-poc-cleanup-snapshot";

let snapshot: DeptPocCleanupSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(DEPT_POC_CLEANUP_SNAPSHOT_PATH, "utf8"),
  ) as DeptPocCleanupSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("production_dept_member: poc_block_write_from_children column does not exist", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'production_dept_member'
        AND column_name = 'poc_block_write_from_children'
    `);
    expect(rows).toHaveLength(0);
  });

  // poc_blocked_permissions 断言已随 migrate-merge-event-department 退役（列 DROP）。

  // poc_extra_permissions 断言已随 migrate-merge-event-department 退役（列 DROP）。

  it("production_dept_member: is_poc is BOOLEAN NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_dept_member'
        AND column_name = 'is_poc'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("pdm_prod_user_idx index still exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'production_dept_member' AND indexname = 'pdm_prod_user_idx'
    `);
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("production_dept_member: no orphan production_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_dept_member pdm
      LEFT JOIN production p ON p.id = pdm.production_id
      WHERE p.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_dept_member: no orphan user_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_dept_member pdm
      LEFT JOIN app_user au ON au.id = pdm.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_dept_member: no orphan dept_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_dept_member pdm
      LEFT JOIN production_dept pd ON pd.id = pdm.dept_id
      WHERE pd.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)(
    "production_dept_member: poc_extra_permissions preserved post-migration",
    async () => {
      const { deptMember, production } = snapshot!;
      const { rows } = await getPool().query<{ poc_extra_permissions: string[] }>(
        `SELECT poc_extra_permissions FROM production_dept_member
         WHERE production_id = $1 AND user_id = $2 AND dept_id = $3`,
        [production.id, deptMember.userId, deptMember.deptId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].poc_extra_permissions.sort()).toEqual(
        [...deptMember.pocExtraPermissions].sort(),
      );
    },
  );

  it.skipIf(!snapshot)(
    "production_dept_member: poc_blocked_permissions preserved post-migration",
    async () => {
      const { deptMember, production } = snapshot!;
      const { rows } = await getPool().query<{ poc_blocked_permissions: string[] }>(
        `SELECT poc_blocked_permissions FROM production_dept_member
         WHERE production_id = $1 AND user_id = $2 AND dept_id = $3`,
        [production.id, deptMember.userId, deptMember.deptId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].poc_blocked_permissions.sort()).toEqual(
        [...deptMember.pocBlockedPermissions].sort(),
      );
    },
  );

  it.skipIf(!snapshot)(
    "production_dept_member: is_poc preserved post-migration",
    async () => {
      const { deptMember, production } = snapshot!;
      const { rows } = await getPool().query<{ is_poc: boolean }>(
        `SELECT is_poc FROM production_dept_member
         WHERE production_id = $1 AND user_id = $2 AND dept_id = $3`,
        [production.id, deptMember.userId, deptMember.deptId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_poc).toBe(deptMember.isPoc);
    },
  );
});
