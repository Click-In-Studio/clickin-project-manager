import { config } from "dotenv";
config({ path: ".env.local" });

import { getPool } from "@/lib/pg";

const TEST_USER = "test-sys-user";

export async function setup() {
  // Generate a deterministic random seed for this test run.
  // Workers inherit process.env, so TEST_SEED will be available in setup.ts.
  if (!process.env.TEST_SEED) {
    process.env.TEST_SEED = String(Math.floor(Math.random() * 0xffff_ffff));
  }
  console.log(
    `\nTest seed: ${process.env.TEST_SEED}  (reproduce: TEST_SEED=${process.env.TEST_SEED} npm test)\n`,
  );

  await getPool().query(
    `INSERT INTO feishu_user (open_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, '测试系统用户', FALSE, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
}

export async function teardown() {
  await getPool().query("DELETE FROM feishu_user WHERE open_id = $1", [TEST_USER]);
  await getPool().end();
}
