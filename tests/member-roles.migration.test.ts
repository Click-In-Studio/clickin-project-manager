/**
 * Migration tests for migrate-member-roles.sql.
 *
 * Operating modes:
 *
 *   Migration path (CI: schema before member-roles migration):
 *     global-setup.ts detects missing production_member_role table,
 *     inserts factory rows, applies the migration, writes snapshot to
 *     MEMBER_ROLES_SNAPSHOT_PATH. All three layers run.
 *
 *   Normal path (already-migrated DB):
 *     global-setup.ts skips. Snapshot file does not exist.
 *     Schema and integrity layers always run; invariance skips (it.skipIf).
 *
 * Layer structure:
 *   1. Schema    — table existence, PK columns, index presence
 *   2. Integrity — no orphan FK references in production_member_role
 *   3. Invariance — factory roles TEXT[] maps correctly to production_member_role rows
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { MEMBER_ROLES_SNAPSHOT_PATH, type MemberRolesSnapshot } from "./member-roles-snapshot";

let snapshot: MemberRolesSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(MEMBER_ROLES_SNAPSHOT_PATH, "utf8")) as MemberRolesSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("production_member_role table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'production_member_role'
    `);
    expect(rows).toHaveLength(1);
  });

  it("production_member_role.production_id is TEXT NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_member_role' AND column_name = 'production_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_member_role.user_id is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_member_role' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_member_role.role_id is TEXT NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_member_role' AND column_name = 'role_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_member_role has composite PK on (production_id, user_id, role_id)", async () => {
    const { rows } = await getPool().query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
      WHERE tc.table_name = 'production_member_role'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `);
    expect(rows.map((r) => r.column_name)).toEqual(["production_id", "user_id", "role_id"]);
  });

  it("pmr_user_prod_idx index exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'production_member_role' AND indexname = 'pmr_user_prod_idx'
    `);
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("production_member_role: no orphan production_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_role pmr
      LEFT JOIN production p ON p.id = pmr.production_id
      WHERE p.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_role: no orphan user_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_role pmr
      LEFT JOIN app_user au ON au.id = pmr.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_role: no orphan role_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_role pmr
      LEFT JOIN production_role pr ON pr.id = pmr.role_id
      WHERE pr.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_role: every row's role belongs to same production as member", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_role pmr
      JOIN production_role pr ON pr.id = pmr.role_id
      WHERE pr.production_id <> pmr.production_id
    `);
    expect(rows[0].cnt).toBe(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)(
    "production_member_role: each role name from TEXT[] maps to a FK row",
    async () => {
      const { production, member } = snapshot!;
      const mismatches: string[] = [];

      for (const roleName of member.roles) {
        const { rows } = await getPool().query<{ role_id: string }>(
          `SELECT pmr.role_id
           FROM production_member_role pmr
           JOIN production_role pr ON pr.id = pmr.role_id
           WHERE pmr.production_id = $1
             AND pmr.user_id = $2
             AND pr.name = $3`,
          [production.id, member.userId, roleName],
        );
        if (rows.length === 0) {
          mismatches.push(`role "${roleName}" not found in production_member_role`);
        }
      }

      expect(mismatches).toEqual([]);
    },
  );

  it.skipIf(!snapshot)(
    "production_member_role: row count matches roles TEXT[] length",
    async () => {
      const { production, member } = snapshot!;
      const { rows } = await getPool().query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM production_member_role
         WHERE production_id = $1 AND user_id = $2`,
        [production.id, member.userId],
      );
      expect(rows[0].cnt).toBe(member.roles.length);
    },
  );

  it.skipIf(!snapshot)(
    "production_member: roles TEXT[] still exists and is unchanged post-migration",
    async () => {
      const { production, member } = snapshot!;
      const { rows } = await getPool().query<{ roles: string[] }>(
        "SELECT roles FROM production_member WHERE production_id = $1 AND user_id = $2",
        [production.id, member.userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].roles.sort()).toEqual([...member.roles].sort());
    },
  );
});
