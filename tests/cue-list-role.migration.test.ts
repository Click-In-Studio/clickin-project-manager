/**
 * Migration tests for migrate-cue-list-role.sql.
 *
 * Operating modes:
 *
 *   Migration path (CI: schema before cue-list-role migration):
 *     global-setup.ts detects old schema (cue_list.default_edit_roles exists),
 *     inserts factory rows, applies the migration, and writes a snapshot to
 *     CUE_LIST_ROLE_SNAPSHOT_PATH. All three layers run, including invariance.
 *
 *   Normal path (already-migrated DB):
 *     global-setup.ts skips the migration. Snapshot file does not exist.
 *     Schema and integrity layers always run; invariance skips (it.skipIf).
 *
 * Layer structure:
 *   1. Schema    — column absence/presence, table existence, index presence
 *   2. Integrity — FK orphan counts in cue_list_role and cue_list_permission
 *   3. Invariance — factory default_edit_roles mapped to cue_list_role rows;
 *                   creator written to cue_list_permission
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

  it("cue_list_role table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'cue_list_role'
    `);
    expect(rows).toHaveLength(1);
  });

  it("cue_list_role.cue_list_id is TEXT NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'cue_list_role' AND column_name = 'cue_list_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("cue_list_role.role_id is TEXT NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'cue_list_role' AND column_name = 'role_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("cue_list_role has primary key on (cue_list_id, role_id)", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'cue_list_role'
        AND tc.constraint_type = 'PRIMARY KEY'
        AND kcu.column_name = 'cue_list_id'
    `);
    expect(rows).toHaveLength(1);
  });

  it("cue_list_role_list_idx index exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'cue_list_role' AND indexname = 'cue_list_role_list_idx'
    `);
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("cue_list_role: no orphan cue_list_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM cue_list_role clr
      LEFT JOIN cue_list cl ON cl.id = clr.cue_list_id
      WHERE cl.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("cue_list_role: no orphan role_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM cue_list_role clr
      LEFT JOIN production_role pr ON pr.id = clr.role_id
      WHERE pr.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("cue_list_permission: no orphan cue_list_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM cue_list_permission clp
      LEFT JOIN cue_list cl ON cl.id = clp.cue_list_id
      WHERE cl.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("cue_list_permission: no orphan user_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM cue_list_permission clp
      LEFT JOIN app_user au ON au.id = clp.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)(
    "cue_list_role: default_edit_roles mapped to production_role IDs",
    async () => {
      const { cueList, production } = snapshot!;
      const mismatches: string[] = [];

      for (const roleName of cueList.defaultEditRoles) {
        // The migration seeds production_role and populates cue_list_role.
        const { rows } = await getPool().query<{ role_id: string }>(
          `SELECT clr.role_id
           FROM cue_list_role clr
           JOIN production_role pr ON pr.id = clr.role_id
           WHERE clr.cue_list_id = $1 AND pr.name = $2 AND pr.production_id = $3`,
          [cueList.id, roleName, production.id],
        );
        if (rows.length === 0) {
          mismatches.push(
            `role "${roleName}" not found in cue_list_role for list ${cueList.id}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    },
  );

  it.skipIf(!snapshot)(
    "cue_list_permission: creator auto-inserted with can_edit=true",
    async () => {
      const { cueList } = snapshot!;
      const { rows } = await getPool().query<{ can_edit: boolean }>(
        `SELECT can_edit FROM cue_list_permission
         WHERE cue_list_id = $1 AND user_id = $2`,
        [cueList.id, cueList.creatorId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].can_edit).toBe(true);
    },
  );

  it.skipIf(!snapshot)(
    "cue_list_role: row count matches defaultEditRoles length",
    async () => {
      const { cueList } = snapshot!;
      const { rows } = await getPool().query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM cue_list_role WHERE cue_list_id = $1`,
        [cueList.id],
      );
      expect(rows[0].cnt).toBe(cueList.defaultEditRoles.length);
    },
  );
});
