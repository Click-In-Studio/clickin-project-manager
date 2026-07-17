import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { Pool } from "pg";
import { getPool } from "@/lib/pg";
import {
  isPreMigrationSchema,
  capturePreMigrationSnapshot,
  SNAPSHOT_PATH,
} from "./migration-snapshot";

// Fixed UUID for the test system user — must match TEST_USER in helpers.ts
const TEST_USER = "00000000-0000-0000-0000-000000000001";

// Deterministic IDs for pre-migration factory data used in invariance tests.
const PRE_MIG_OPEN_IDS = ["gm-inv-user-1", "gm-inv-user-2", "gm-inv-user-3"];
const PRE_MIG_PROD_ID = "inv-test-prod-1";
const PRE_MIG_CL_ID = "inv-test-cl-1";

export async function setup() {
  // Generate deterministic TEST_SEED for faker (workers inherit process.env).
  if (!process.env.TEST_SEED) {
    process.env.TEST_SEED = String(Math.floor(Math.random() * 0xffff_ffff));
  }
  console.log(
    `\nTest seed: ${process.env.TEST_SEED}  (reproduce: TEST_SEED=${process.env.TEST_SEED} npm test)\n`,
  );

  const pool = getPool();

  if (await isPreMigrationSchema(pool)) {
    // Migration path: DB is on the old schema.
    // Insert factory rows so the invariance snapshot has real data to verify against.
    await insertPreMigrationFactoryData(pool);
    const snapshot = await capturePreMigrationSnapshot(pool);
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot));
    const migrationSql = await readFile(
      path.resolve(process.cwd(), "db/migrate-internal-user-id.sql"),
      "utf8",
    );
    await pool.query(migrationSql);
  }

  // Insert the test system user (always runs on post-migration schema).
  // app_user must exist before feishu_user (FK: feishu_user.user_id → app_user.id).
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ('test-sys-feishu', $1, '测试系统用户', FALSE, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
}

async function insertPreMigrationFactoryData(pool: Pool): Promise<void> {
  // feishu_user rows — old schema has no user_id column yet.
  for (const openId of PRE_MIG_OPEN_IDS) {
    await pool.query(
      `INSERT INTO feishu_user (open_id, name, is_super_admin)
       VALUES ($1, $2, FALSE) ON CONFLICT DO NOTHING`,
      [openId, `迁移测试用户 ${openId}`],
    );
  }

  // A production to anchor production_member, cue_list, production_event, and comment rows.
  await pool.query(
    `INSERT INTO production (id, name) VALUES ($1, '迁移不变性测试演出')
     ON CONFLICT DO NOTHING`,
    [PRE_MIG_PROD_ID],
  );

  // production_member — old schema PK is (production_id, open_id).
  for (const openId of PRE_MIG_OPEN_IDS) {
    await pool.query(
      `INSERT INTO production_member (production_id, open_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [PRE_MIG_PROD_ID, openId],
    );
  }

  // cue_list — created_by is TEXT FK → feishu_user.open_id on old schema.
  await pool.query(
    `INSERT INTO cue_list (id, production_id, name, created_by)
     VALUES ($1, $2, '迁移测试 Cue List', $3) ON CONFLICT DO NOTHING`,
    [PRE_MIG_CL_ID, PRE_MIG_PROD_ID, PRE_MIG_OPEN_IDS[0]],
  );

  // production_event — created_by is TEXT FK → feishu_user.open_id on old schema.
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, created_by)
     VALUES (gen_random_uuid()::text, $1, '迁移测试排练', $2)`,
    [PRE_MIG_PROD_ID, PRE_MIG_OPEN_IDS[1]],
  );

  // comment — open_id + mentions with { openId } for JSONB invariance test.
  await pool.query(
    `INSERT INTO comment (production_id, context_type, context_id, open_id, author_name, body, mentions)
     VALUES ($1, 'block', 'inv-ctx-1', $2, '迁移测试用户', '迁移测试评论', $3)`,
    [PRE_MIG_PROD_ID, PRE_MIG_OPEN_IDS[0], JSON.stringify([{ openId: PRE_MIG_OPEN_IDS[2] }])],
  );
}

export async function teardown() {
  const pool = getPool();

  // Tables with RESTRICT FK to app_user (no ON DELETE CASCADE from production):
  // cue_list.created_by and production_event.created_by were created by TEST_USER in normal tests.
  await pool.query("DELETE FROM cue_list WHERE created_by = $1", [TEST_USER]);
  await pool.query("DELETE FROM production_event WHERE created_by = $1", [TEST_USER]);

  // Clean up pre-migration factory data (present only on migration path; no-ops otherwise).
  // DELETE FROM production cascades to production_member, cue_list, production_event, comment.
  await pool.query("DELETE FROM production WHERE id = $1", [PRE_MIG_PROD_ID]).catch(() => {});
  // Delete app_user records created by migration for the inv users; cascades to feishu_user.
  await pool.query(
    "DELETE FROM app_user WHERE id IN (SELECT user_id FROM feishu_user WHERE open_id = ANY($1))",
    [PRE_MIG_OPEN_IDS],
  ).catch(() => {});

  // Deleting app_user cascades to feishu_user, production_member, comment, etc.
  await pool.query("DELETE FROM app_user WHERE id = $1", [TEST_USER]);
  await pool.end();
}
