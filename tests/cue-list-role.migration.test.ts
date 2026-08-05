/**
 * Migration tests for migrate-cue-list-role.sql.
 *
 * Note: Phase 4 (migrate-cue-list-to-resource-grant.sql) subsequently dropped
 * cue_list_role and cue_list_permission. The schema/integrity layers below reflect
 * the FINAL post-Phase-4 state. Invariance tests are guarded by it.skipIf(!snapshot)
 * and are skipped on already-migrated DBs where the snapshot file does not exist.
 *
 * Layer structure:
 *   1. Schema    — cue_list.default_edit_roles column is gone;
 *                  cue_list_role and cue_list_permission tables are also gone (Phase 4)
 *   2. Integrity — resource_grant table exists and has no orphan user/production FK refs
 *   3. Invariance — (skipped on already-migrated DBs; factory data verification)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { CUE_LIST_ROLE_SNAPSHOT_PATH, type CueListRoleSnapshot } from "./cue-list-role-snapshot";

let snapshot: CueListRoleSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(CUE_LIST_ROLE_SNAPSHOT_PATH, "utf8")) as CueListRoleSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("cue_list.default_edit_roles column is gone", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'cue_list' AND column_name = 'default_edit_roles'
    `);
    expect(rows).toHaveLength(0);
  });

  // Phase 4 dropped both tables; they must not exist post-migration.
  it("cue_list_role table is gone (dropped by Phase 4)", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'cue_list_role'
    `);
    expect(rows).toHaveLength(0);
  });

  it("cue_list_permission table is gone (dropped by Phase 4)", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'cue_list_permission'
    `);
    expect(rows).toHaveLength(0);
  });

  it("resource_grant table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'resource_grant'
    `);
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

// Phase 4 removed cue_list_role and cue_list_permission; data migrated to resource_grant.
// Integrity checks now verify resource_grant cue_list rows are consistent.
describe("integrity verification", () => {
  it("resource_grant(cue_list): no orphan user_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM resource_grant rg
      LEFT JOIN app_user au ON au.id = rg.user_id
      WHERE rg.resource_type = 'cue_list' AND au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("resource_grant(cue_list): no orphan production_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM resource_grant rg
      LEFT JOIN production p ON p.id = rg.production_id
      WHERE rg.resource_type = 'cue_list' AND p.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("resource_grant(cue_list): no duplicate active grants", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM (
        SELECT production_id, user_id, resource_type, resource_id, resource_sub, permission_level
        FROM resource_grant
        WHERE resource_type = 'cue_list' AND NOT is_revoked
        GROUP BY production_id, user_id, resource_type, resource_id, resource_sub, permission_level
        HAVING COUNT(*) > 1
      ) dups
    `);
    expect(rows[0].cnt).toBe(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  // Phase 4 subsequently migrated cue_list_role/cue_list_permission → resource_grant.
  // Invariance now verified against resource_grant (the final destination).
  it.skipIf(!snapshot)(
    "resource_grant: creator has manage grant (via Phase 4 migration)",
    async () => {
      const { cueList } = snapshot!;
      const { rows } = await getPool().query(
        `SELECT 1 FROM resource_grant
         WHERE resource_type = 'cue_list' AND resource_id = $1
           AND user_id = $2 AND permission_level = 'manage' AND NOT is_revoked`,
        [cueList.id, cueList.creatorId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.skipIf(!snapshot)(
    "resource_grant: cue list has at least one edit grant (defaultEditRoles migrated)",
    async () => {
      const { cueList } = snapshot!;
      const { rows } = await getPool().query(
        `SELECT COUNT(*)::int AS cnt FROM resource_grant
         WHERE resource_type = 'cue_list' AND resource_id = $1
           AND permission_level = 'edit' AND NOT is_revoked`,
        [cueList.id],
      );
      // defaultEditRoles were mapped to role members; at least the creator's edit grant exists
      expect(rows[0].cnt).toBeGreaterThanOrEqual(1);
    },
  );
});
