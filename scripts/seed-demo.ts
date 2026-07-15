/**
 * Download the demo seed data from R2 (public bucket) and load it into
 * the local database.
 *
 * Usage:
 *   npm run seed:demo
 *
 * Only requires local DB credentials (PGUSER/PGPASSWORD in .env.local or shell env).
 * No R2 credentials needed — the seed file is publicly accessible.
 *
 * The seed file is generated and uploaded by the maintainer with:
 *   npm run seed:export -- "供养2.0" "我们的星星"
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { Pool } from "pg";

const SEED_URL =
  process.env.SEED_URL ?? "https://pub-50e9ef6dfe944ca8aa2288e45f20ba7c.r2.dev/seed-data/demo.sql";

const pool = new Pool({
  database: process.env.PGDATABASE ?? "script_editor",
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

async function main() {
  console.log(`Downloading seed data from ${SEED_URL}…`);
  const res = await fetch(SEED_URL);
  if (!res.ok) {
    console.error(`Failed to download seed file: ${res.status} ${res.statusText}`);
    console.error(`Ask a maintainer to run: npm run seed:export -- "供养2.0" "我们的星星"`);
    process.exit(1);
  }

  const sql = await res.text();
  console.log(`Downloaded ${(Buffer.byteLength(sql) / 1024 / 1024).toFixed(1)} MB. Loading into local DB…`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Demo seed data loaded successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
