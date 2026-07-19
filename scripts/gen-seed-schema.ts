/**
 * Generates db/seed-schema.json — a structural fingerprint of the DB schema
 * used by the conventions test to detect schema drift vs the committed seed.
 *
 * Run: npx tsx scripts/gen-seed-schema.ts > db/seed-schema.json
 * Or add to package.json: "seed:schema": "tsx scripts/gen-seed-schema.ts > db/seed-schema.json"
 */
// Suppress dotenv stdout noise by loading via env var directly
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Pool } from "pg";

async function main() {
  const pool = new Pool({
    database: process.env.PGDATABASE ?? "script_editor",
    host: process.env.PGHOST ?? "localhost",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  const res = await pool.query<{
    table_name: string; column_name: string;
    data_type: string; is_nullable: string; column_default: string | null;
  }>(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name NOT LIKE 'test-%'
    ORDER BY table_name, ordinal_position
  `);
  const schema: Record<string, { column: string; type: string; nullable: boolean; default?: string }[]> = {};
  for (const r of res.rows) {
    if (!schema[r.table_name]) schema[r.table_name] = [];
    const entry: { column: string; type: string; nullable: boolean; default?: string } = {
      column: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES",
    };
    if (r.column_default) entry.default = r.column_default.substring(0, 80);
    schema[r.table_name].push(entry);
  }
  process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
  await pool.end();
}

main();
