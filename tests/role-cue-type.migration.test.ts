/**
 * Migration tests for migrate-role-cue-type-to-dept.sql.
 *
 * Migration path (CI: production_role_cue_type table exists):
 *   global-setup.ts detects pre-migration, inserts factory rows, applies migration,
 *   writes snapshot to ROLE_CUE_TYPE_SNAPSHOT_PATH.
 *   All three layers run.
 *
 * Normal path (already-migrated DB):
 *   Snapshot file does not exist. Schema and integrity layers run;
 *   invariance skips (it.skipIf).
 *
 * Layer structure:
 *   1. Schema    — production_role_cue_type table DROPPED; production_dept.allowed_cue_types still exists
 *   2. Integrity — no orphan dept_id in production_dept; allowed_cue_types is NOT NULL
 *   3. Invariance — factory dept now has the cue_type in its allowed_cue_types
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { ROLE_CUE_TYPE_SNAPSHOT_PATH, type RoleCueTypeSnapshot } from "./role-cue-type-snapshot";

let snapshot: RoleCueTypeSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(ROLE_CUE_TYPE_SNAPSHOT_PATH, "utf8")) as RoleCueTypeSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("production_role_cue_type table has been dropped", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'production_role_cue_type'
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_dept.allowed_cue_types column still exists as TEXT[] NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_dept' AND column_name = 'allowed_cue_types'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("ARRAY");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_dept table still exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'production_dept'
    `);
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("production_dept: no rows with NULL allowed_cue_types", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt FROM production_dept
      WHERE allowed_cue_types IS NULL
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
    "factory dept has the migrated cue_type in allowed_cue_types",
    async () => {
      const { dept, cueType } = snapshot!;
      const { rows } = await getPool().query<{ allowed_cue_types: string[] }>(
        `SELECT allowed_cue_types FROM production_dept WHERE id = $1`,
        [dept.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].allowed_cue_types).toContain(cueType);
    },
  );

  it.skipIf(!snapshot)(
    "factory dept has no extra cue_types beyond what was migrated",
    async () => {
      const { dept, cueType } = snapshot!;
      const { rows } = await getPool().query<{ allowed_cue_types: string[] }>(
        `SELECT allowed_cue_types FROM production_dept WHERE id = $1`,
        [dept.id],
      );
      expect(rows[0].allowed_cue_types).toEqual([cueType]);
    },
  );
});
