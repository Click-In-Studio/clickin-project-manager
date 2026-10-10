import { spawnSync } from "node:child_process";
import { faker } from "@faker-js/faker";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseUrlFromEnv } from "../../scripts/db-url";

// 全量 CLI 会重建固定 demo id，必须使用独立的、从 migrations 建立的数据库。
const database = `local_demo_${process.pid}_${Date.now().toString(36)}`;
const ownerId = faker.string.uuid();
const otherUserId = faker.string.uuid();
const demoId = "demo-misty-harbor";
const controlId = `control-${faker.string.uuid()}`;
const admin = new Client({ connectionString: databaseUrlFromEnv(process.env, { database: process.env.PGADMINDB ?? "postgres" }) });
const client = new Client({ connectionString: databaseUrlFromEnv(process.env, { database }) });
let created = false;

function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`${command} 执行失败：${result.error ?? result.status}`);
  }
  return result.stdout;
}

function seed() {
  return run("npm", ["run", "seed:local-demo"], { ...process.env, PGDATABASE: database, NODE_ENV: "development" });
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  run(path.resolve("node_modules/.bin/dbmate"), [
    "--url", databaseUrlFromEnv(process.env, { database }),
    "--migrations-dir", "db/migrations", "--no-dump-schema", "up",
  ]);
  await client.connect();
  await client.query("INSERT INTO app_user (id) VALUES ($1), ($2)", [ownerId, otherUserId]);
  await client.query("INSERT INTO user_profile (user_id, name) VALUES ($1, '演示开发者')", [ownerId]);
  await client.query(
    `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method)
     VALUES ($1, 'email', $2, true)`, [ownerId, `${ownerId}@example.invalid`],
  );
}, 60_000);

afterAll(async () => {
  await client.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

it("全量 CLI 可从头运行及重跑，只为登录用户置顶 demo，保留其他项目", async () => {
  // 没有其他项目时也必须完整造数，覆盖不存在排序锚点的分支。
  expect(seed()).toContain("Demo project ready for 演示开发者");
  const first = (await client.query("SELECT owner_id, active_version_id FROM production WHERE id=$1", [demoId])).rows[0];
  expect(first.owner_id).toBe(ownerId);
  await client.query("INSERT INTO production (id, name, owner_id) VALUES ($1, '保留项目', $2)", [controlId, ownerId]);
  await client.query(
    `INSERT INTO user_production_order (id, user_id, production_id, sort_key)
     VALUES ('control-owner', $1, $3, 'h000000000'), ('control-other', $2, $3, 's000000000')`,
    [ownerId, otherUserId, controlId],
  );

  expect(seed()).toContain("Demo project ready for 演示开发者");
  const second = (await client.query("SELECT owner_id, active_version_id FROM production WHERE id=$1", [demoId])).rows[0];
  expect(second.owner_id).toBe(ownerId);
  expect(second.active_version_id).not.toBe(first.active_version_id);
  const order = (await client.query(
    "SELECT production_id FROM user_production_order WHERE user_id=$1 ORDER BY sort_key", [ownerId],
  )).rows.map(row => row.production_id);
  expect(order).toEqual([demoId, controlId]);
  expect((await client.query("SELECT name, owner_id FROM production WHERE id=$1", [controlId])).rows)
    .toEqual([{ name: "保留项目", owner_id: ownerId }]);
  expect((await client.query("SELECT production_id, sort_key FROM user_production_order WHERE user_id=$1", [otherUserId])).rows)
    .toEqual([{ production_id: controlId, sort_key: "s000000000" }]);
  const counts = (await client.query(
    `SELECT
       (SELECT count(*)::int FROM script WHERE production_id=$1) AS blocks,
       (SELECT count(*)::int FROM scene WHERE production_id=$1) AS scenes,
       (SELECT count(*)::int FROM production_event WHERE production_id=$1) AS events,
       (SELECT count(*)::int FROM production_material WHERE production_id=$1) AS materials,
       (SELECT count(*)::int FROM production_expense WHERE production_id=$1) AS expenses`, [demoId],
  )).rows[0];
  expect(counts).toEqual({ blocks: 8, scenes: 4, events: 16, materials: 5, expenses: 13 });
}, 60_000);
