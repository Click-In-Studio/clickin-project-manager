/**
 * 打印当前库的结构指纹（db/fingerprint.sql 的输出），一行一对象。
 *
 *   npm run db:fingerprint                 连 .env.local 指定的库
 *   npm run db:fingerprint -- --database x 连同一服务器上的另一个库
 *
 * 想知道「我本地这个库和 schema.sql 差在哪」：
 *   npm run db:fingerprint | diff db/schema-fingerprint.txt -
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readFile } from "node:fs/promises";
import { Client } from "pg";

export const FINGERPRINT_SQL_PATH = "db/fingerprint.sql";

export async function fingerprintDatabase(database?: string): Promise<string[]> {
  const sql = await readFile(FINGERPRINT_SQL_PATH, "utf8");
  const client = new Client({
    database: database ?? process.env.PGDATABASE ?? "script_editor",
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ line: string }>(sql);
    return rows.map((r) => r.line);
  } finally {
    await client.end();
  }
}

async function main() {
  const i = process.argv.indexOf("--database");
  const database = i >= 0 ? process.argv[i + 1] : undefined;
  const lines = await fingerprintDatabase(database);
  process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && /db-fingerprint\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
