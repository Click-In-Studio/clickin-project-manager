import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

// globalSetup 跑在主进程（拿不到 vitest 的 test.env），而 migration hook 可能把整个
// .sql 当一条 query 执行——生产的 statement_timeout 是按单条业务语句定的，对不上。
// 与 vitest.config.ts 的 test.env 同值，两处覆盖的是两个进程。
process.env.PG_STATEMENT_TIMEOUT_MS ??= "60000";

import { readdir, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import type { Pool } from "pg";
import { getPool } from "@/lib/pg";
import { faker } from "@faker-js/faker";
import { databaseUrlFromEnv } from "../../scripts/db-url";

// Fixed UUID for the test system user — must match TEST_USER in helpers.ts
const TEST_USER = "00000000-0000-0000-0000-000000000001";
const TEST_OWNER = "00000000-0000-0000-0000-0000000000ff";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");
const HOOKS_DIR = path.resolve(process.cwd(), "tests/migrations");

// ─────────────────────────────────────────────────────────────────────────────
// Migration hook 契约（#561）
//
// CI 的 migration path：库先按 origin/main 的 db/migrations 建好（旧结构），本函数
// 发现 PR 新增的 migration 还没应用 → 对每支去找同名 hook 造「迁移前」的工厂数据并
// 快照 → `dbmate up` → 测试里 `it.skipIf(!snapshot)` 拿快照做 invariance 断言。
//
// hook 文件：tests/migrations/<name>.snapshot.ts，<name> 与 db/migrations/<版本>_<name>.sql
// 的 <name> 完全一致。导出：
//   SNAPSHOT_PATH            快照 JSON 落在哪（测试同样从这里 readFileSync）
//   createPreMigrationData   (ctx) => Promise<snapshot>，在旧结构上造数
//   cleanup?                 (pool, snapshot) => Promise<void>，teardown 清工厂行
//
// 没有 hook 的 migration（纯加列加表）直接应用，什么都不用写。本地已迁移的库没有
// pending，整段跳过，invariance 层自动 skip——这是预期行为。
// ─────────────────────────────────────────────────────────────────────────────

export type MigrationHookContext = {
  pool: Pool;
  faker: typeof faker;
  /** 测试系统用户（已存在，可作 creator / member） */
  testUser: string;
  /** 建演出专用 owner（与 testUser 分开，见 helpers.ts TEST_OWNER 注释） */
  testOwner: string;
};

export interface MigrationHook<S = unknown> {
  SNAPSHOT_PATH: string;
  createPreMigrationData(ctx: MigrationHookContext): Promise<S>;
  cleanup?(pool: Pool, snapshot: S): Promise<void>;
}

type RanHook = { name: string; hook: MigrationHook; snapshot: unknown };
const ranHooks: RanHook[] = [];

async function pendingMigrations(pool: Pool): Promise<{ version: string; name: string }[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  const { rows } = await pool.query<{ t: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS t",
  );
  const applied = new Set<string>(
    rows[0]?.t
      ? (await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version)
      : [],
  );
  return files
    .map((f) => ({ version: f.slice(0, 14), name: f.slice(15, -4) }))
    .filter((m) => !applied.has(m.version));
}

function dbmateUp() {
  const bin = path.join(process.cwd(), "node_modules", ".bin", "dbmate");
  const r = spawnSync(
    bin,
    ["--url", databaseUrlFromEnv(), "--migrations-dir", "db/migrations", "--no-dump-schema", "up"],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`dbmate up 失败（exit ${r.status}）`);
}

export async function setup() {
  // Generate deterministic TEST_SEED for faker (workers inherit process.env).
  if (!process.env.TEST_SEED) {
    process.env.TEST_SEED = String(Math.floor(Math.random() * 0xffff_ffff));
  }
  console.log(
    `\nTest seed: ${process.env.TEST_SEED}  (reproduce: TEST_SEED=${process.env.TEST_SEED} npm test)\n`,
  );

  const pool = getPool();
  const pending = await pendingMigrations(pool);

  // 有表却没有 schema_migrations = dbmate 接管前建的库。不能让 baseline 在它上面
  // 重放（幂等归幂等，几千行 DDL 在一个有数据的库上跑没必要），记一行账即可。
  if (pending.some((m) => m.name === "baseline")) {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'",
    );
    if (Number(rows[0].n) > 0) {
      throw new Error(
        "测试库已有表但没有 schema_migrations 记账（dbmate 接管前建的库）。\n" +
        "跑一次 `npm run db -- mark-baseline` 记下 baseline，再 npm test。",
      );
    }
    // 空库：baseline 本身就是第一支 migration，直接 up。
    dbmateUp();
    pending.splice(0, pending.length, ...(await pendingMigrations(pool)));
  }

  // Insert the test system user. app_user must exist before feishu_user (FK).
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
  // 建演出用的专用 owner（与 TEST_USER 分开，见 helpers.ts TEST_OWNER 注释）
  await pool.query(
    `INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING`,
    [TEST_OWNER],
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ('test-sys-feishu', $1, '测试系统用户', FALSE, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [TEST_USER],
  );
  // #280 建项目门：既有路由测试全部用 TEST_USER 会话建项目，给 internal 档
  // （无数量上限——测试 DB 状态共享，creator 的配额会被历史残骸挤爆产生 flake）。
  // 「无档 → 403」「creator 配额」分支由 tests/plan.test.ts 用新造用户专测。
  await pool.query(
    `INSERT INTO user_plan (user_id, tier, source) VALUES ($1, 'internal', 'test-setup')
     ON CONFLICT (user_id) DO NOTHING`,
    [TEST_USER],
  );

  if (pending.length === 0) return;

  console.log(`Pending migrations: ${pending.map((m) => m.name).join(", ")}`);
  const ctx: MigrationHookContext = { pool, faker, testUser: TEST_USER, testOwner: TEST_OWNER };
  for (const m of pending) {
    const hookPath = path.join(HOOKS_DIR, `${m.name}.snapshot.ts`);
    if (!existsSync(hookPath)) continue;
    const hook = (await import(hookPath)) as MigrationHook;
    if (typeof hook.createPreMigrationData !== "function" || !hook.SNAPSHOT_PATH) {
      throw new Error(`${path.relative(process.cwd(), hookPath)} 必须导出 SNAPSHOT_PATH 与 createPreMigrationData`);
    }
    console.log(`  hook: ${m.name} → 造迁移前数据并快照`);
    const snapshot = await hook.createPreMigrationData(ctx);
    await writeFile(hook.SNAPSHOT_PATH, JSON.stringify(snapshot));
    ranHooks.push({ name: m.name, hook, snapshot });
  }
  dbmateUp();
}

export async function teardown() {
  const pool = getPool();

  for (const { name, hook, snapshot } of ranHooks.reverse()) {
    if (hook.cleanup) {
      await hook.cleanup(pool, snapshot).catch((e) =>
        console.error(`[migration hook teardown] ${name}:`, e instanceof Error ? e.message : e),
      );
    }
    await unlink(hook.SNAPSHOT_PATH).catch(() => {});
  }

  // Deleting app_user cascades to feishu_user, production_member, comment, etc.
  await pool.query("DELETE FROM app_user WHERE id = $1", [TEST_USER]);
  await pool.end();
}
