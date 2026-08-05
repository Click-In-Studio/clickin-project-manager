/**
 * Migration tests for migrate-event-department.sql.
 *
 * Operating modes:
 *
 *   Migration path (CI: production_dept is empty):
 *     global-setup.ts detects pre-migration, inserts factory rows in event_department,
 *     applies migrate-event-department.sql, writes snapshot to EVENT_DEPT_SNAPSHOT_PATH.
 *     All three layers run.
 *
 *   Normal path (already-migrated DB):
 *     Snapshot file does not exist. Schema and integrity layers run;
 *     invariance skips (it.skipIf).
 *
 * Layer structure:
 *   1. Schema    — production_dept and production_dept_member table shape,
 *                  resource_dept_manage and production_approval_config existence
 *   2. Integrity — no orphan FKs in production_dept_member
 *   3. Invariance — every factory dept/member from event_department appears in
 *                   production_dept/production_dept_member post-migration
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { EVENT_DEPT_SNAPSHOT_PATH, type EventDeptSnapshot } from "./event-department-snapshot";

let snapshot: EventDeptSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(EVENT_DEPT_SNAPSHOT_PATH, "utf8")) as EventDeptSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("production_dept table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'production_dept'
    `);
    expect(rows).toHaveLength(1);
  });

  it("production_dept has allowed_cue_types TEXT[] NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_dept' AND column_name = 'allowed_cue_types'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("ARRAY");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_dept has permissions TEXT[] NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_dept' AND column_name = 'permissions'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("ARRAY");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_dept has parent_id nullable UUID", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_dept' AND column_name = 'parent_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("YES");
  });

  it("production_dept_member does NOT have poc_block_write_from_children", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'production_dept_member'
        AND column_name = 'poc_block_write_from_children'
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_dept_member has poc_blocked_permissions TEXT[] NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_dept_member'
        AND column_name = 'poc_blocked_permissions'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("ARRAY");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("resource_dept_manage table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'resource_dept_manage'
    `);
    expect(rows).toHaveLength(1);
  });

  it("resource_dept_manage has resource_id NOT NULL DEFAULT '*'", async () => {
    const { rows } = await getPool().query(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'resource_dept_manage' AND column_name = 'resource_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("*");
  });

  it("production_approval_config table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'production_approval_config'
    `);
    expect(rows).toHaveLength(1);
  });

  it("production_approval_config ttl_hours has CHECK constraint", async () => {
    const { rows } = await getPool().query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'production_approval_config'::regclass
        AND contype = 'c'
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const defs = rows.map((r) => r.def).join(" ");
    expect(defs).toContain("ttl_hours");
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

  it("production_dept: no orphan parent_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_dept pd
      LEFT JOIN production_dept parent ON parent.id = pd.parent_id
      WHERE pd.parent_id IS NOT NULL AND parent.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_dept_member: production_id matches dept's production_id", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_dept_member pdm
      JOIN production_dept pd ON pd.id = pdm.dept_id
      WHERE pd.production_id <> pdm.production_id
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("resource_dept_manage: no orphan dept_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM resource_dept_manage rdm
      LEFT JOIN production_dept pd ON pd.id = rdm.dept_id
      WHERE pd.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)(
    "event_department factory dept exists in production_dept by name",
    async () => {
      const { dept, production } = snapshot!;
      const { rows } = await getPool().query<{ id: string; display_order: number }>(
        `SELECT id, display_order FROM production_dept
         WHERE production_id = $1 AND name = $2 AND parent_id IS NULL`,
        [production.id, dept.name],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].display_order).toBe(dept.displayOrder);
    },
  );

  it.skipIf(!snapshot)(
    "event_department_member (is_member=true) maps to production_dept_member",
    async () => {
      const { dept, production, members } = snapshot!;
      const memberMembers = members.filter((m) => m.isMember);
      expect(memberMembers.length).toBeGreaterThan(0);

      for (const member of memberMembers) {
        const { rows } = await getPool().query<{ is_poc: boolean }>(
          `SELECT pdm.is_poc FROM production_dept_member pdm
           JOIN production_dept pd ON pd.id = pdm.dept_id
           WHERE pd.production_id = $1 AND pd.name = $2
             AND pdm.user_id = $3 AND pdm.production_id = $1`,
          [production.id, dept.name, member.userId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].is_poc).toBe(member.isPoc);
      }
    },
  );

  it.skipIf(!snapshot)(
    "event_department_member (is_member=false) NOT in production_dept_member",
    async () => {
      const { dept, production, members } = snapshot!;
      const nonMembers = members.filter((m) => !m.isMember);

      for (const member of nonMembers) {
        const { rows } = await getPool().query(
          `SELECT 1 FROM production_dept_member pdm
           JOIN production_dept pd ON pd.id = pdm.dept_id
           WHERE pd.production_id = $1 AND pd.name = $2 AND pdm.user_id = $3`,
          [production.id, dept.name, member.userId],
        );
        expect(rows).toHaveLength(0);
      }
    },
  );

  it.skipIf(!snapshot)(
    "event_department (kind='group') NOT in production_dept",
    async () => {
      // We didn't create any 'group' factory rows, but we verify the migration
      // rule by checking that no production_dept rows have a name matching
      // any event_department group from our factory production.
      const { production } = snapshot!;
      const { rows: groupRows } = await getPool().query<{ name: string }>(
        "SELECT name FROM event_department WHERE production_id = $1 AND kind = 'group'",
        [production.id],
      );
      for (const { name } of groupRows) {
        const { rows } = await getPool().query(
          "SELECT 1 FROM production_dept WHERE production_id = $1 AND name = $2",
          [production.id, name],
        );
        expect(rows).toHaveLength(0);
      }
    },
  );
});
