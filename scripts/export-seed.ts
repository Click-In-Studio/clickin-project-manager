/**
 * Export one or more productions from the local DB and upload the SQL seed
 * file to a public R2 bucket at key "seed-data/demo.sql".
 *
 * Usage:
 *   npm run seed:export -- "供养2.0" "我们的星星"
 *
 * Required env vars (in .env.local):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   SEED_R2_BUCKET   — name of the public R2 bucket (e.g. "click-in-seed")
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { Pool, PoolClient } from "pg";
import crypto from "crypto";

const pool = new Pool({
  database: process.env.PGDATABASE ?? "script_editor",
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

// ── R2 upload (targets SEED_R2_BUCKET, independent of main bucket config) ────

async function uploadSeed(key: string, body: Buffer): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.SEED_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / SEED_R2_BUCKET");
  }

  const region = "auto";
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const contentType = "text/plain; charset=utf-8";
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const path = `/${bucket}/${key}`;

  const canonicalHeaders =
    `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [`PUT`, path, ``, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credScope = `${dateStr}/${region}/s3/aws4_request`;
  const strToSign = ["AWS4-HMAC-SHA256", amzDate, credScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");

  const hmac = (k: Buffer | string, d: string) =>
    crypto.createHmac("sha256", k).update(d).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStr), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(strToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${path}`, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`R2 PUT failed: ${res.status} ${await res.text()}`);
}

// ── Value formatting ──────────────────────────────────────────────────────────

function lit(val: unknown, dataType: string): string {
  if (val === null || val === undefined) return "NULL";
  switch (dataType) {
    case "boolean": return val ? "TRUE" : "FALSE";
    case "integer": case "bigint": case "numeric":
    case "double precision": case "real": case "smallint":
      return String(val);
    case "jsonb": case "json":
      return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
    case "ARRAY": {
      const arr = val as unknown[];
      if (arr.length === 0) return "ARRAY[]::text[]";
      return `ARRAY[${arr.map((v) => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`).join(",")}]`;
    }
    default:
      if (val instanceof Date) return `'${val.toISOString()}'`;
      return `'${String(val).replace(/'/g, "''")}'`;
  }
}

// ── Core exporter ─────────────────────────────────────────────────────────────

type ColInfo = { column_name: string; data_type: string };

async function exportTable(client: PoolClient, table: string, where: string, params: unknown[]): Promise<string> {
  const colRes = await client.query<ColInfo>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  const cols = colRes.rows;
  if (cols.length === 0) return `-- (table ${table} not found)\n`;

  const rowRes = await client.query(`SELECT * FROM "${table}" WHERE ${where}`, params);
  if (rowRes.rows.length === 0) return `-- ${table}: 0 rows\n`;

  const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");
  const lines = [`-- ${table} (${rowRes.rows.length} rows)`];
  for (const row of rowRes.rows) {
    const values = cols.map((c) => lit(row[c.column_name], c.data_type)).join(", ");
    lines.push(`INSERT INTO "${table}" (${colNames}) VALUES (${values}) ON CONFLICT DO NOTHING;`);
  }
  return lines.join("\n") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('Usage: npm run seed:export -- "名称1" "名称2"');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const pidRes = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM production WHERE name = ANY($1)", [names]
    );
    if (pidRes.rows.length === 0) { console.error(`Not found: ${names.join(", ")}`); process.exit(1); }

    const missing = names.filter((n) => !pidRes.rows.some((r) => r.name === n));
    if (missing.length > 0) console.warn(`Warning: not found: ${missing.join(", ")}`);

    const pids = pidRes.rows.map((r) => r.id);
    const pidList = pids.map((_, i) => `$${i + 1}`).join(", ");
    console.log(`Exporting: ${pidRes.rows.map((r) => `${r.name} (${r.id})`).join(", ")}`);

    const vSub = `version_id IN (SELECT id FROM version WHERE production_id IN (${pidList}))`;
    const sections: string[] = [];
    const add = async (table: string, where: string) =>
      sections.push(await exportTable(client, table, where, pids));

    await add("production",         `id IN (${pidList})`);
    await add("version",            `production_id IN (${pidList})`);
    await add("scene",              `production_id IN (${pidList})`);
    await add("character",          `production_id IN (${pidList})`);
    await add("character_aggregate",`aggregate_id IN (SELECT id FROM character WHERE production_id IN (${pidList}))`);
    await add("tag_group",          `production_id IN (${pidList})`);
    await add("tag_option",         `group_id IN (SELECT id FROM tag_group WHERE production_id IN (${pidList}))`);
    await add("cue_list",           `production_id IN (${pidList})`);
    await add("scene_version",      vSub);
    await add("character_version",  vSub);
    await add("script",             `production_id IN (${pidList})`);
    await add("script_character",   `script_id IN (SELECT id FROM script WHERE production_id IN (${pidList}))`);
    await add("script_version",     vSub);
    await add("block_tag",          `block_id IN (SELECT DISTINCT block_id FROM script WHERE production_id IN (${pidList}))`);
    await add("cue",                `cue_list_id IN (SELECT id FROM cue_list WHERE production_id IN (${pidList}))`);
    await add("cue_version",        vSub);

    const header = [
      `-- Demo seed data`,
      `-- Productions: ${pidRes.rows.map((r) => r.name).join(", ")}`,
      `-- Generated: ${new Date().toISOString()}`,
      `-- Re-running seed:demo replaces only these productions; other local data is untouched.`,
      ``,
      `DELETE FROM production WHERE id IN (${pids.map((id) => `'${id}'`).join(", ")});`,
      ``,
    ].join("\n");

    const sql = header + sections.join("\n");
    const buf = Buffer.from(sql, "utf-8");
    const R2_KEY = "seed-data/demo.sql";
    console.log(`Uploading to R2 bucket "${process.env.SEED_R2_BUCKET}": ${R2_KEY} (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
    await uploadSeed(R2_KEY, buf);
    console.log("Done. Testers can now run: npm run seed:demo");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
