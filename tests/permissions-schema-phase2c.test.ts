/**
 * Schema verification for Phase 2c permission infrastructure tables.
 *
 * Covers three tables introduced or corrected in Phase 2c:
 *   - resource_grant         (corrected in add-resource-grant.sql)
 *   - resource_permission_level  (new, add-resource-permission-level.sql)
 *   - atomic_permission_grant    (new, add-atomic-permission-grant.sql)
 *
 * These are add-* files (no data migration), so no invariance layer is needed.
 * All three layers (schema / integrity / seed-data) are covered here.
 */
import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";

// ── resource_grant ────────────────────────────────────────────────────────────

describe("resource_grant schema (Phase 2c)", () => {
  it("table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'resource_grant'
    `);
    expect(rows).toHaveLength(1);
  });

  it("user_id column is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'resource_grant' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("grantee_type column does not exist", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'resource_grant' AND column_name = 'grantee_type'
    `);
    expect(rows).toHaveLength(0);
  });

  it("grantee_id column does not exist", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'resource_grant' AND column_name = 'grantee_id'
    `);
    expect(rows).toHaveLength(0);
  });

  it("resource_id is TEXT NOT NULL (default '*')", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'resource_grant' AND column_name = 'resource_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("*");
  });

  it("resource_sub is TEXT NOT NULL (default '*')", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'resource_grant' AND column_name = 'resource_sub'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("*");
  });

  it("confirmed_by is nullable (auto grant has no trigger user)", async () => {
    const { rows } = await getPool().query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'resource_grant' AND column_name = 'confirmed_by'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("YES");
  });

  it("grant_source CHECK includes 'auto' and 'assigned'", async () => {
    const { rows } = await getPool().query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'resource_grant'::regclass
        AND contype = 'c'
        AND conname LIKE '%grant_source%'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("auto");
    expect(rows[0].def).toContain("assigned");
  });

  it("revoked_reason CHECK includes 'dept_dissolved' and 'poc_change'", async () => {
    const { rows } = await getPool().query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'resource_grant'::regclass
        AND contype = 'c'
        AND conname LIKE '%revoked_reason%'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("dept_dissolved");
    expect(rows[0].def).toContain("poc_change");
  });

  it("resource_grant_active_unique_idx (partial) exists on correct columns", async () => {
    const { rows } = await getPool().query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'resource_grant'
        AND indexname = 'resource_grant_active_unique_idx'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("resource_id");
    expect(rows[0].indexdef).toContain("resource_sub");
    expect(rows[0].indexdef).toContain("user_id");
    expect(rows[0].indexdef).toContain("is_revoked");
  });

  it("resource_grant_lookup_idx exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'resource_grant' AND indexname = 'resource_grant_lookup_idx'
    `);
    expect(rows).toHaveLength(1);
  });

  it("permission_level FK to resource_permission_level exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'resource_grant'::regclass
        AND contype = 'f'
        AND conname = 'resource_grant_level_fk'
    `);
    expect(rows).toHaveLength(1);
  });
});

// ── resource_permission_level ─────────────────────────────────────────────────

describe("resource_permission_level schema + seed data (Phase 2c)", () => {
  it("table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'resource_permission_level'
    `);
    expect(rows).toHaveLength(1);
  });

  it("primary key is (resource_type, permission_level)", async () => {
    const { rows } = await getPool().query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_name = tc.table_name
      WHERE tc.table_name = 'resource_permission_level'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `);
    expect(rows.map((r) => r.column_name)).toEqual(["resource_type", "permission_level"]);
  });

  it("contains standard cue_list levels in correct order", async () => {
    // 批0（add-rest-verbs.sql）起词汇表含 REST 动词行 create/delete（sort_order=0，
    // 刻意低于一切旧级别，避免旧线性 checker 误判命中）。
    const { rows } = await getPool().query<{ permission_level: string; sort_order: number }>(
      `SELECT permission_level, sort_order FROM resource_permission_level
       WHERE resource_type = 'cue_list' ORDER BY sort_order, permission_level`,
    );
    expect(rows.map((r) => r.permission_level)).toEqual(["create", "delete", "view", "mount", "edit", "manage"]);
    expect(rows.filter((r) => r.sort_order === 0).map((r) => r.permission_level)).toEqual(["create", "delete"]);
  });

  it("contains event workflow levels (publish, edit_published, revoke)", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'event' ORDER BY sort_order`,
    );
    const levels = rows.map((r) => r.permission_level);
    expect(levels).toContain("publish");
    expect(levels).toContain("edit_published");
    expect(levels).toContain("revoke");
  });

  it("contains tech_req 'assign' level", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_permission_level
       WHERE resource_type = 'tech_req' AND permission_level = 'assign'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("contains script_view levels", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'script_view' ORDER BY sort_order, permission_level`,
    );
    // 批0 起含 REST 动词行 create/delete（sort_order=0）
    expect(rows.map((r) => r.permission_level)).toEqual(["create", "delete", "view", "edit", "manage"]);
  });

  it("has entries for all expected resource types", async () => {
    const { rows } = await getPool().query<{ resource_type: string }>(
      `SELECT DISTINCT resource_type FROM resource_permission_level ORDER BY resource_type`,
    );
    const types = rows.map((r) => r.resource_type);
    for (const expected of [
      "asset", "cue_list", "event", "note", "report", "scene", "script_view", "tech_req",
    ]) {
      expect(types).toContain(expected);
    }
  });
});

// ── atomic_permission_grant ───────────────────────────────────────────────────

describe("atomic_permission_grant schema (Phase 2c)", () => {
  it("table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'atomic_permission_grant'
    `);
    expect(rows).toHaveLength(1);
  });

  it("user_id is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'atomic_permission_grant' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("permission_key is TEXT NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'atomic_permission_grant' AND column_name = 'permission_key'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("grant_source CHECK includes 'auto' and 'assigned'", async () => {
    const { rows } = await getPool().query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'atomic_permission_grant'::regclass
        AND contype = 'c'
        AND conname LIKE '%grant_source%'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("auto");
    expect(rows[0].def).toContain("assigned");
  });

  it("revoked_reason CHECK includes 'poc_change'", async () => {
    const { rows } = await getPool().query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'atomic_permission_grant'::regclass
        AND contype = 'c'
        AND conname LIKE '%revoked_reason%'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("poc_change");
  });

  it("atomic_permission_grant_active_unique_idx (partial) exists", async () => {
    const { rows } = await getPool().query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'atomic_permission_grant'
        AND indexname = 'atomic_permission_grant_active_unique_idx'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("is_revoked");
  });

  it("atomic_permission_grant_lookup_idx exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'atomic_permission_grant'
        AND indexname = 'atomic_permission_grant_lookup_idx'
    `);
    expect(rows).toHaveLength(1);
  });
});
