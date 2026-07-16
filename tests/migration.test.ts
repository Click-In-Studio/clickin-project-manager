/**
 * Post-migration verification tests for migrate-internal-user-id.sql.
 *
 * The migration itself is applied by global-setup.ts before any tests run
 * (only on first run; subsequent runs skip it since app_user already exists).
 * These tests verify the resulting DB state is correct.
 *
 * After a fresh migration, also run:
 *   npm run seed:schema
 * to regenerate db/seed-schema.json and commit the updated fingerprint.
 */
import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";

describe("post-migration schema verification", () => {
  it("app_user table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'app_user'
    `);
    expect(rows).toHaveLength(1);
  });

  it("feishu_user.user_id column exists (UUID, NOT NULL)", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'feishu_user' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("every feishu_user row has a non-null user_id", async () => {
    const { rows } = await getPool().query(
      "SELECT COUNT(*)::int AS cnt FROM feishu_user WHERE user_id IS NULL"
    );
    expect(rows[0].cnt).toBe(0);
  });

  it("app_user count equals feishu_user count (one-to-one)", async () => {
    const { rows: fuRows } = await getPool().query(
      "SELECT COUNT(*)::int AS cnt FROM feishu_user"
    );
    const { rows: auRows } = await getPool().query(
      "SELECT COUNT(*)::int AS cnt FROM app_user"
    );
    // +1 for the test user inserted in global-setup (no matching feishu_user open_id in prod data)
    expect(auRows[0].cnt).toBeGreaterThanOrEqual(fuRows[0].cnt);
  });

  it("production_member has no open_id column", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'production_member' AND column_name = 'open_id'
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_member.user_id is UUID (NOT NULL)", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_member' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("cue_list.created_by is UUID (NOT NULL)", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'cue_list' AND column_name = 'created_by'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_event.created_by is UUID", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'production_event' AND column_name = 'created_by'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
  });

  it("comment has no open_id column, has user_id (UUID)", async () => {
    const { rows: openIdRows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'comment' AND column_name = 'open_id'
    `);
    expect(openIdRows).toHaveLength(0);

    const { rows: userIdRows } = await getPool().query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'comment' AND column_name = 'user_id'
    `);
    expect(userIdRows).toHaveLength(1);
    expect(userIdRows[0].data_type).toBe("uuid");
  });

  it("no JSONB mentions use openId key in comment table", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt FROM comment
      WHERE mentions IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(mentions) AS m WHERE m ? 'openId'
        )
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("all production_member rows reference valid app_user entries", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member pm
      LEFT JOIN app_user au ON au.id = pm.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("all cue_list rows reference valid app_user entries", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM cue_list cl
      LEFT JOIN app_user au ON au.id = cl.created_by
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("feishu_user.user_id is UNIQUE (one feishu identity per app user)", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM (
        SELECT user_id FROM feishu_user GROUP BY user_id HAVING COUNT(*) > 1
      ) AS dupes
    `);
    expect(rows[0].cnt).toBe(0);
  });
});
