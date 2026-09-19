/**
 * schema 三方一致性检查（CI 每次跑；本地改 schema 后跑）。
 *
 * 建两个临时库：一个只跑 `dbmate up`（db/migrations 从 baseline 到最新），一个只
 * 跑 `psql -f db/schema.sql`，各取结构指纹，要求
 *
 *     migrations 指纹 == schema.sql 指纹 == 提交的 db/schema-fingerprint.txt
 *
 * 三者缺一不可：前者保证「migration 写了、schema.sql 也同步了」（以前靠人记得，
 * 忘了就静默漂移）；后者让 CD 在服务器上只用一份文本文件 + psql 就能核对线上
 * 与仓库是否一致，不需要在服务器上重建库。
 *
 *   npm run db:check              校验；不一致打印 diff 并退 1
 *   npm run db:check -- --update  以 schema.sql 为准重写 db/schema-fingerprint.txt
 *                                 （migrations 侧仍须一致，否则照样退 1）
 *
 * 需要建库权限：本地 Homebrew 的 OS 用户、CI 容器的 POSTGRES_USER 都有。
 * 临时库名带 pid，同机并发跑也不撞；结束必删。
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { databaseUrlFromEnv } from "./db-url";
import { fingerprintDatabase } from "./db-fingerprint";

const FINGERPRINT_FILE = "db/schema-fingerprint.txt";
const SCHEMA_FILE = "db/schema.sql";

function adminClient(): Client {
  return new Client({
    database: process.env.PGADMINDB ?? "postgres",
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
}

function runOrThrow(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败（exit ${r.status}）\n${r.stdout}\n${r.stderr}`);
  }
}

async function buildFromMigrations(db: string) {
  const bin = path.join(process.cwd(), "node_modules", ".bin", "dbmate");
  runOrThrow(bin, [
    "--url", databaseUrlFromEnv(process.env, { database: db }),
    "--migrations-dir", "db/migrations",
    "--no-dump-schema",
    "up",
  ]);
}

async function buildFromSchema(db: string) {
  // 用 psql 而不是 pg 驱动：schema.sql 是按 psql -f 的语义写的（逐条自动提交，
  // ALTER TYPE ADD VALUE 后面紧接着就能用新值），整段塞进一条 simple query 会变成
  // 单个隐式事务，语义不同。CI 与线上初始化走的也是 psql。
  runOrThrow("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", db, "-f", SCHEMA_FILE], {
    ...process.env,
    PGDATABASE: db,
  });
}

function diffLines(label: string, a: string[], b: string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  const out: string[] = [];
  for (const l of a) if (!sb.has(l)) out.push(`  只在 ${label.split(" vs ")[0]}: ${l}`);
  for (const l of b) if (!sa.has(l)) out.push(`  只在 ${label.split(" vs ")[1]}: ${l}`);
  return out;
}

async function main() {
  const update = process.argv.includes("--update");
  const tag = `${process.pid}_${Date.now().toString(36)}`;
  const dbMig = `schema_check_migrations_${tag}`;
  const dbSch = `schema_check_schema_${tag}`;

  const admin = adminClient();
  await admin.connect();
  const drop = async () => {
    for (const db of [dbMig, dbSch]) {
      await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => {});
    }
  };
  try {
    for (const db of [dbMig, dbSch]) await admin.query(`CREATE DATABASE "${db}"`);

    await buildFromMigrations(dbMig);
    await buildFromSchema(dbSch);

    const fpMig = await fingerprintDatabase(dbMig);
    const fpSch = await fingerprintDatabase(dbSch);

    const problems: string[] = [];

    const d1 = diffLines("migrations vs schema.sql", fpMig, fpSch);
    if (d1.length) {
      problems.push(
        `db/migrations 跑出来的库 与 db/schema.sql 建出来的库 结构不一致（${d1.length} 处）：\n` +
        d1.join("\n") +
        `\n→ 新 migration 的 DDL 要同步写进 db/schema.sql（或反过来）。`,
      );
    }

    if (update) {
      await writeFile(FINGERPRINT_FILE, fpSch.join("\n") + "\n");
      console.log(`已按 schema.sql 重写 ${FINGERPRINT_FILE}（${fpSch.length} 行）`);
    } else {
      const committed = (await readFile(FINGERPRINT_FILE, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean);
      const d2 = diffLines("schema.sql vs schema-fingerprint.txt", fpSch, committed);
      if (d2.length) {
        problems.push(
          `db/schema.sql 与提交的 ${FINGERPRINT_FILE} 不一致（${d2.length} 处）：\n` +
          d2.join("\n") +
          `\n→ 跑 \`npm run db:check -- --update\` 重新生成并一起提交。`,
        );
      }
    }

    if (problems.length) {
      console.error(problems.join("\n\n"));
      process.exitCode = 1;
    } else {
      console.log(`schema 一致：migrations == schema.sql == ${FINGERPRINT_FILE}（${fpSch.length} 行）`);
    }
  } finally {
    await drop();
    await admin.end();
  }
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
