/**
 * Migration tests for migrate-cue-list-to-resource-grant.sql.
 *
 * Migration path (CI: cue_list_permission table exists):
 *   global-setup.ts detects pre-migration, inserts factory rows, applies migration,
 *   writes snapshot to CUE_LIST_GRANT_SNAPSHOT_PATH.
 *   All three layers run.
 *
 * Normal path (already-migrated DB):
 *   Snapshot file does not exist. Schema and integrity layers run;
 *   invariance skips (it.skipIf).
 *
 * Layer structure:
 *   1. Schema    — cue_list_permission and cue_list_role tables DROPPED;
 *                  production_member_grant still has edit/manage levels for cue_list
 *   2. Integrity — production_member_grant: no orphan user_id/production_id FKs for cue_list type
 *   3. Invariance — factory users (creator, personal grant, role grant) all have
 *                   active production_member_grant rows for the factory cue list
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { CUE_LIST_GRANT_SNAPSHOT_PATH, type CueListGrantSnapshot } from "./cue-list-grant-snapshot";

let snapshot: CueListGrantSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(CUE_LIST_GRANT_SNAPSHOT_PATH, "utf8")) as CueListGrantSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("cue_list_permission table has been dropped", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'cue_list_permission'
    `);
    expect(rows).toHaveLength(0);
  });

  it("cue_list_role table has been dropped", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'cue_list_role'
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_member_grant table still exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'production_member_grant'
    `);
    expect(rows).toHaveLength(1);
  });

  it("resource_permission_level has cue_list verb entries (批A 后 manage/mount 退役)", async () => {
    const { rows } = await getPool().query(`
      SELECT permission_level FROM resource_permission_level
      WHERE resource_type = 'cue_list'
      ORDER BY sort_order
    `);
    const levels = rows.map((r) => r.permission_level);
    expect(levels).toContain("edit");
    expect(levels).toContain("view");
    expect(levels).not.toContain("manage");
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("production_member_grant(cue_list): no orphan user_id", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_grant rg
      LEFT JOIN app_user au ON au.id = rg.user_id
      WHERE rg.resource_type = 'cue_list' AND au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_grant(cue_list): no orphan production_id", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_grant rg
      LEFT JOIN production p ON p.id = rg.production_id
      WHERE rg.resource_type = 'cue_list' AND p.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_grant: all cue_list permission_levels are valid", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_grant rg
      LEFT JOIN resource_permission_level rpl
        ON rpl.resource_type = rg.resource_type
        AND rpl.permission_level = rg.permission_level
      WHERE rg.resource_type = 'cue_list' AND rpl.permission_level IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_grant: no duplicate active grants", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt FROM (
        SELECT production_id, user_id, resource_type, resource_id, resource_sub, permission_level,
               COUNT(*) AS c
        FROM production_member_grant
        WHERE NOT is_revoked AND resource_type = 'cue_list'
        GROUP BY production_id, user_id, resource_type, resource_id, resource_sub, permission_level
        HAVING COUNT(*) > 1
      ) dup
    `);
    expect(rows[0].cnt).toBe(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)(
    "creator (testUserId) has active manage grant on factory cue list",
    async () => {
      const { cueList, production } = snapshot!;
      const { rows } = await getPool().query(
        `SELECT permission_level FROM production_member_grant
         WHERE production_id = $1 AND user_id = $2
           AND resource_type = 'cue_list' AND resource_id = $3
           AND permission_level = 'manage' AND NOT is_revoked`,
        [production.id, cueList.creatorId, cueList.id],
      );
      expect(rows).toHaveLength(1);
    },
  );

  it.skipIf(!snapshot)(
    "creator (testUserId) also has active edit grant on factory cue list",
    async () => {
      const { cueList, production } = snapshot!;
      const { rows } = await getPool().query(
        `SELECT permission_level FROM production_member_grant
         WHERE production_id = $1 AND user_id = $2
           AND resource_type = 'cue_list' AND resource_id = $3
           AND permission_level = 'edit' AND NOT is_revoked`,
        [production.id, cueList.creatorId, cueList.id],
      );
      expect(rows).toHaveLength(1);
    },
  );

  it.skipIf(!snapshot)(
    "personal-grant user has active edit grant on factory cue list",
    async () => {
      const { cueList, production, personalGrantUserId } = snapshot!;
      const { rows } = await getPool().query(
        `SELECT permission_level FROM production_member_grant
         WHERE production_id = $1 AND user_id = $2
           AND resource_type = 'cue_list' AND resource_id = $3
           AND permission_level = 'edit' AND NOT is_revoked`,
        [production.id, personalGrantUserId, cueList.id],
      );
      expect(rows).toHaveLength(1);
    },
  );

  it.skipIf(!snapshot)(
    "role-based grant user has active edit grant on factory cue list",
    async () => {
      const { cueList, production, roleGrantUserId } = snapshot!;
      const { rows } = await getPool().query(
        `SELECT permission_level FROM production_member_grant
         WHERE production_id = $1 AND user_id = $2
           AND resource_type = 'cue_list' AND resource_id = $3
           AND permission_level = 'edit' AND NOT is_revoked`,
        [production.id, roleGrantUserId, cueList.id],
      );
      expect(rows).toHaveLength(1);
    },
  );
});
