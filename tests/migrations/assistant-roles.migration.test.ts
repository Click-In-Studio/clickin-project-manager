/**
 * Migration tests for migrate-assistant-roles.sql.
 *
 * This is a data-only migration (no schema change beyond is_deprecated already added).
 * The invariance layer runs its own beforeAll/afterAll: it creates a factory production
 * with composite roles, runs the migration SQL, and verifies the transformation.
 * Since the migration is idempotent, re-running on an already-migrated DB is safe.
 *
 * Layer structure:
 *   1. Schema    — is_deprecated column exists in production_role with correct type/default
 *   2. Integrity — no composite role row has both is_deprecated=false AND a base role FK missing
 *   3. Invariance — factory composite role maps to base role + tag post-migration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { getPool } from "@/lib/pg";
import { faker } from "@faker-js/faker";

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("production_role.is_deprecated column exists", async () => {
    const { rows } = await getPool().query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'production_role' AND column_name = 'is_deprecated'
    `);
    expect(rows).toHaveLength(1);
  });

  it("production_role.is_deprecated is BOOLEAN NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'production_role' AND column_name = 'is_deprecated'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBe("false");
  });

  it("production_member_tag table exists with id/name/is_system columns", async () => {
    const { rows } = await getPool().query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'production_member_tag'
        AND column_name IN ('id', 'name', 'is_system', 'production_id')
      ORDER BY column_name
    `);
    expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
      "id",
      "is_system",
      "name",
      "production_id",
    ]);
  });

  it("production_member_tag_assignment has composite PK (production_id, user_id, tag_id)", async () => {
    const { rows } = await getPool().query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
      WHERE tc.table_name = 'production_member_tag_assignment'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `);
    expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
      "production_id",
      "user_id",
      "tag_id",
    ]);
  });

  it("system tags 助理 and 副 exist in production_member_tag", async () => {
    const { rows } = await getPool().query(`
      SELECT name FROM production_member_tag
      WHERE name IN ('助理', '副') AND is_system = true AND production_id IS NULL
    `);
    const names = rows.map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining(["助理", "副"]));
    expect(names).toHaveLength(2);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("production_member_tag_assignment: no orphan production_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_tag_assignment pmta
      LEFT JOIN production p ON p.id = pmta.production_id
      WHERE p.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_tag_assignment: no orphan user_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_tag_assignment pmta
      LEFT JOIN app_user au ON au.id = pmta.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("production_member_tag_assignment: no orphan tag_id references", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member_tag_assignment pmta
      LEFT JOIN production_member_tag pmt ON pmt.id = pmta.tag_id
      WHERE pmt.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("all deprecated composite roles have a corresponding active base role in same production", async () => {
    const compositeToBase: Record<string, string> = {
      导演助理: "导演",
      助理舞台监督: "舞台监督",
      副导演: "导演",
      音乐导演助理: "音乐导演",
      作曲助理: "作曲",
      多媒体设计助理: "多媒体设计",
      服化设计助理: "服化设计",
      灯光设计助理: "灯光设计",
      舞美设计助理: "舞美设计",
      音响设计助理: "音响设计",
    };
    for (const [composite, base] of Object.entries(compositeToBase)) {
      const { rows } = await getPool().query(
        `
        SELECT COUNT(*)::int AS cnt
        FROM production_role composite_pr
        LEFT JOIN production_role base_pr
          ON base_pr.production_id = composite_pr.production_id
         AND base_pr.name = $2
         AND base_pr.is_deprecated = false
        WHERE composite_pr.name = $1
          AND composite_pr.is_deprecated = true
          AND base_pr.id IS NULL
        `,
        [composite, base],
      );
      expect(rows[0].cnt).toBe(0);
    }
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

type AssistantRolesSnapshot = {
  prodId: string;
  userId: string;
  compositeRoleId: string;
  compositeName: string;
  baseName: string;
  tagName: string;
};

let snapshot: AssistantRolesSnapshot | null = null;

describe("invariance verification", () => {
  beforeAll(async () => {
    const pool = getPool();
    const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
    const userId = "00000000-0000-0000-0000-000000000011";
    const compositeRoleId = `pr_test_${prodId}_composite`;
    const compositeName = "导演助理";
    const baseName = "导演";
    const tagName = "助理";

    // owner_id NOT NULL：app_user 必须先于 production 存在（原本插在后面）
    await pool.query(
      "INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING",
      [userId],
    );
    // Create a minimal production + version
    await pool.query(
      "INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, "迁移测试演出-助理职位", userId],
    );
    // version.name 已随版本退役删除（migrate-version-retire.sql）——本工厂在
    // 当前 schema 上无条件运行，不能再引用化石列
    await pool.query(
      "INSERT INTO version (id, production_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING",
      [`${prodId}_v1`, prodId],
    );
    await pool.query(
      "UPDATE production SET active_version_id = $1 WHERE id = $2",
      [`${prodId}_v1`, prodId],
    );

    // Create test user（app_user 已在 production 之前插入）
    await pool.query(
      `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
       VALUES ($1, $2, '迁移测试用户', false, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [`test-migration-${prodId}`, userId],
    );

    // Insert the composite role
    await pool.query(
      "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [compositeRoleId, prodId, compositeName],
    );

    // Add member with the composite role
    await pool.query(
      "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, userId, [compositeName]],
    );
    await pool.query(
      "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, userId, compositeRoleId],
    );

    snapshot = { prodId, userId, compositeRoleId, compositeName, baseName, tagName };

    // Run the migration (idempotent — safe to re-run)
    const migrationSql = readFileSync(
      path.resolve(process.cwd(), "db/migrate-assistant-roles.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  });

  afterAll(async () => {
    if (!snapshot) return;
    await getPool()
      .query("DELETE FROM production WHERE id = $1", [snapshot.prodId])
      .catch(() => {});
    await getPool()
      .query("DELETE FROM app_user WHERE id = $1", [snapshot.userId])
      .catch(() => {});
    snapshot = null;
  });

  it("composite role is marked is_deprecated=true after migration", async () => {
    expect(snapshot).not.toBeNull();
    const { prodId, compositeName } = snapshot!;
    const { rows } = await getPool().query(
      "SELECT is_deprecated FROM production_role WHERE production_id = $1 AND name = $2",
      [prodId, compositeName],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_deprecated).toBe(true);
  });

  it("base role row exists in the same production", async () => {
    expect(snapshot).not.toBeNull();
    const { prodId, baseName } = snapshot!;
    const { rows } = await getPool().query(
      "SELECT id FROM production_role WHERE production_id = $1 AND name = $2 AND is_deprecated = false",
      [prodId, baseName],
    );
    expect(rows).toHaveLength(1);
  });

  it("member is assigned to base role via production_member_role", async () => {
    expect(snapshot).not.toBeNull();
    const { prodId, userId, baseName } = snapshot!;
    const { rows } = await getPool().query(
      `SELECT pmr.role_id
       FROM production_member_role pmr
       JOIN production_role pr ON pr.id = pmr.role_id
       WHERE pmr.production_id = $1 AND pmr.user_id = $2 AND pr.name = $3`,
      [prodId, userId, baseName],
    );
    expect(rows).toHaveLength(1);
  });

  it("member has tag assignment for the correct system tag", async () => {
    expect(snapshot).not.toBeNull();
    const { prodId, userId, tagName } = snapshot!;
    const { rows } = await getPool().query(
      `SELECT pmta.tag_id
       FROM production_member_tag_assignment pmta
       JOIN production_member_tag pmt ON pmt.id = pmta.tag_id
       WHERE pmta.production_id = $1 AND pmta.user_id = $2
         AND pmt.name = $3 AND pmt.is_system = true`,
      [prodId, userId, tagName],
    );
    expect(rows).toHaveLength(1);
  });

  it("production_member.roles TEXT[] updated to base role name", async () => {
    expect(snapshot).not.toBeNull();
    const { prodId, userId, baseName, compositeName } = snapshot!;
    const { rows } = await getPool().query<{ roles: string[] }>(
      "SELECT roles FROM production_member WHERE production_id = $1 AND user_id = $2",
      [prodId, userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].roles).toContain(baseName);
    expect(rows[0].roles).not.toContain(compositeName);
  });
});
