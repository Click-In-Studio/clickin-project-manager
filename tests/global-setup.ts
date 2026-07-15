import { getPool } from "@/lib/pg";

const TEST_USER = "test-sys-user";

export async function setup() {
  await getPool().query(
    `INSERT INTO feishu_user (open_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, '测试系统用户', FALSE, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [TEST_USER]
  );
}

export async function teardown() {
  await getPool().query("DELETE FROM feishu_user WHERE open_id = $1", [TEST_USER]);
  await getPool().end();
}
