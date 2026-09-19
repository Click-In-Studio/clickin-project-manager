/**
 * dbmate 包装：`npm run db -- <dbmate 子命令>`。
 *
 *   npm run db -- up            应用全部 pending migration
 *   npm run db -- status        看哪些已应用 / 哪些 pending（--exit-code：有 pending 退 1）
 *   npm run db -- new <name>    生成 db/migrations/<时间戳>_<name>.sql
 *   npm run db -- down          回滚最近一支（只对写了 migrate:down 的有意义）
 *
 * 固定三件事，调用方不用记：
 *   - URL 从 .env.local 的 PG* 拼（DATABASE_URL 显式给了就用它）；
 *   - 目录固定 db/migrations；
 *   - --no-dump-schema：db/schema.sql 是手写的规范文件，不让 dbmate 用 pg_dump
 *     覆盖（pg_dump 输出随客户端版本变、且丢掉全部设计注释）。schema.sql 与
 *     migrations 的一致性由 `npm run db:check` 用结构指纹保证。
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { spawnSync } from "node:child_process";
import path from "node:path";
import { databaseUrlFromEnv } from "./db-url";

const bin = path.join(process.cwd(), "node_modules", ".bin", "dbmate");
const url = process.env.DATABASE_URL ?? databaseUrlFromEnv();

/**
 * 自定义子命令：`npm run db -- mark-baseline`
 * 已有的库（接管前建的本地库、线上库）不跑 baseline，只记一行「已应用」。
 * dbmate 没有 mark 命令，这里直接写它的表（结构与 dbmate 2.36 自建的一致）。
 */
async function markBaseline() {
  const { Client } = await import("pg");
  const { readdirSync } = await import("node:fs");
  const baseline = readdirSync("db/migrations").filter((f) => /^\d{14}_baseline\.sql$/.test(f)).sort()[0];
  if (!baseline) {
    console.error("[db] 找不到 db/migrations/*_baseline.sql");
    process.exit(1);
  }
  const version = baseline.slice(0, 14);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS public.schema_migrations (version VARCHAR(128) PRIMARY KEY)");
    const r = await client.query(
      "INSERT INTO public.schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
      [version],
    );
    console.log(r.rowCount ? `[db] 已记 baseline ${version}` : `[db] baseline ${version} 早已记账`);
  } finally {
    await client.end();
  }
}

function runDbmate() {
  const args = [
    "--url", url,
    "--migrations-dir", "db/migrations",
    "--no-dump-schema",
    ...process.argv.slice(2),
  ];
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.error) {
    console.error(`[db] 启动 dbmate 失败：${r.error.message}（先 npm ci）`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

if (process.argv[2] === "mark-baseline") {
  markBaseline().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  runDbmate();
}
