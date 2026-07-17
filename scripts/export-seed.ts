/**
 * Export one or more productions from the local DB and upload the SQL seed
 * file to a public R2 bucket.
 *
 * Usage:
 *   npm run seed:export    -- "供养2.0" "我们的星星"          # demo seed
 *   npm run seed:export    -- --ci "供养2.0" "我们的星星"     # CI seed (anonymized)
 *
 * Required env vars (in .env.local):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   SEED_R2_BUCKET   — name of the public R2 bucket (e.g. "click-in-seed")
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { Pool, PoolClient } from "pg";
import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";

const pool = new Pool({
  database: process.env.PGDATABASE ?? "script_editor",
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

// ── R2 upload ─────────────────────────────────────────────────────────────────

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
  const urlPath = `/${bucket}/${key}`;

  const canonicalHeaders =
    `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [`PUT`, urlPath, ``, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credScope = `${dateStr}/${region}/s3/aws4_request`;
  const strToSign = ["AWS4-HMAC-SHA256", amzDate, credScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");

  const hmac = (k: Buffer | string, d: string) =>
    crypto.createHmac("sha256", k).update(d).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStr), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(strToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${urlPath}`, {
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

async function exportTable(
  client: PoolClient,
  table: string,
  where: string,
  params: unknown[],
  nullCols: string[] = [],
  skipCols: string[] = [],
): Promise<string> {
  const colRes = await client.query<ColInfo>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  const skipSet = new Set(skipCols);
  const cols = colRes.rows.filter((c) => !skipSet.has(c.column_name));
  if (cols.length === 0) return `-- (table ${table} not found)\n`;

  const rowRes = await client.query(`SELECT * FROM "${table}" WHERE ${where}`, params);
  if (rowRes.rows.length === 0) return `-- ${table}: 0 rows\n`;

  const nullSet = new Set(nullCols);
  const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");
  const lines = [`-- ${table} (${rowRes.rows.length} rows)`];
  for (const row of rowRes.rows) {
    const values = cols.map((c) =>
      nullSet.has(c.column_name) ? "NULL" : lit(row[c.column_name], c.data_type)
    ).join(", ");
    lines.push(`INSERT INTO "${table}" (${colNames}) VALUES (${values}) ON CONFLICT DO NOTHING;`);
  }
  return lines.join("\n") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const ciMode = args.includes("--ci");
  const names = args.filter((a) => !a.startsWith("--"));
  if (names.length === 0) {
    console.error('Usage: npm run seed:export -- [--ci] "名称1" "名称2"');
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
    // Safe literal lists for embedding in SQL strings (not parameterized)
    const idList = pids.map((id) => `'${id}'`).join(", ");
    console.log(`Exporting${ciMode ? " [CI mode]" : ""}: ${pidRes.rows.map((r) => `${r.name} (${r.id})`).join(", ")}`);

    // ── Detect schema version at runtime ─────────────────────────────────────
    // After `migrate-internal-user-id.sql` runs, `app_user` table exists.
    const hasAppUser: boolean = await client
      .query<{ exists: boolean }>("SELECT to_regclass('public.app_user') IS NOT NULL AS exists")
      .then((r) => r.rows[0].exists);

    // ── Build open_id anonymization map (CI mode) ────────────────────────────
    // Map ALL feishu_users so every open_id reference anywhere in the SQL is covered.
    // In new schema, also capture user_id (UUID FK) so we can emit correct feishu_user rows.
    type UserRow = { open_id: string; name: string; user_id?: string };
    let openIdMap = new Map<string, string>();    // real open_id → fake open_id
    let nameToFakeId = new Map<string, string>(); // real name → fake open_id (for JSONB repair)
    let userIdByOpenId = new Map<string, string>(); // real open_id → app_user UUID
    if (ciMode) {
      const cols = hasAppUser ? "open_id, name, user_id" : "open_id, name";
      const allUsers = await client.query<UserRow>(
        `SELECT ${cols} FROM feishu_user ORDER BY open_id`
      );
      allUsers.rows.forEach((r, i) => {
        const fakeId = `seed-user-${i + 1}`;
        openIdMap.set(r.open_id, fakeId);
        if (r.name) nameToFakeId.set(r.name, fakeId);
        if (r.user_id) userIdByOpenId.set(r.open_id, r.user_id);
      });
    }

    // ── Subquery helpers ─────────────────────────────────────────────────────
    const vSub = `version_id IN (SELECT id FROM version WHERE production_id IN (${idList}))`;
    const cueSub = `cue_list_id IN (SELECT id FROM cue_list WHERE production_id IN (${idList}))`;
    const evSub = `event_id IN (SELECT id FROM production_event WHERE production_id IN (${idList}))`;
    const rptSub = `report_id IN (SELECT id FROM event_report WHERE ${evSub})`;
    const treqSub = `req_id IN (SELECT id FROM event_tech_req WHERE ${evSub})`;
    const sitemSub = `item_id IN (SELECT id FROM event_schedule_item WHERE ${evSub})`;
    const deptSub = `department_id IN (SELECT id FROM event_department WHERE production_id IN (${idList}))`;

    // Columns to null out in CI mode (internal IDs, storage keys, personal URLs)
    const CI_NULL_FEISHU_USER  = ["email", "phone", "avatar_url"];
    const CI_NULL_PROD_MEMBER  = ["photo_url"];
    const CI_NULL_ASSET        = ["feishu_url"];
    const CI_NULL_ASSET_FILE   = ["r2_key", "thumbnail_r2_key"];
    const CI_NULL_CHAT_ID      = ["chat_id"];

    const sections: string[] = [];

    // Helper: export table, optionally with CI-specific nullCols
    const add = async (
      table: string,
      where: string,
      params: unknown[],
      { nullCols = [], skipCols = [], ciNullCols = [] }: {
        nullCols?: string[];
        skipCols?: string[];
        ciNullCols?: string[];
      } = {}
    ) => {
      const effectiveNullCols = ciMode ? [...nullCols, ...ciNullCols] : nullCols;
      sections.push(await exportTable(client, table, where, params, effectiveNullCols, skipCols));
    };

    // ── TIER 0: no FK deps ───────────────────────────────────────────────────

    // CI only: demo mode skips global tables (local DB already has real rows).
    if (ciMode) {
      // app_user: new schema only — export all (just UUIDs, no PII)
      if (hasAppUser) {
        sections.push(
          await exportTable(client, "app_user",
            "id IN (SELECT user_id FROM feishu_user)", [])
        );
      }

      // feishu_user: export ALL users, anonymized
      const lines = [`-- feishu_user (${openIdMap.size} rows, anonymized)`];
      if (hasAppUser) {
        // New schema: feishu_user has user_id FK to app_user
        for (const [realId, fakeId] of openIdMap) {
          const n = fakeId.split("-").pop();
          const uid = userIdByOpenId.get(realId) ?? "";
          lines.push(
            `INSERT INTO "feishu_user" ("open_id","name","avatar_url","is_super_admin","created_at","updated_at","email","phone","user_id") ` +
            `VALUES ('${fakeId}','演示用户${n}',NULL,FALSE,NOW(),NOW(),NULL,NULL,'${uid}') ON CONFLICT DO NOTHING;`
          );
        }
      } else {
        // Old schema: no user_id column
        for (const [, fakeId] of openIdMap) {
          const n = fakeId.split("-").pop();
          lines.push(
            `INSERT INTO "feishu_user" ("open_id","name","avatar_url","is_super_admin","created_at","updated_at","email","phone") ` +
            `VALUES ('${fakeId}','演示用户${n}',NULL,FALSE,NOW(),NOW(),NULL,NULL) ON CONFLICT DO NOTHING;`
          );
        }
      }
      sections.push(lines.join("\n") + "\n");

      // bot_testers: still uses open_id in both schemas (intentionally excluded from migration)
      await add("bot_testers", "TRUE", [], { ciNullCols: ["name"] });
    }

    // ── TIER 1: deps on feishu_user / production ─────────────────────────────

    // production: null active_version_id to break circular FK; restored at footer
    await add("production", `id IN (${idList})`, [], { nullCols: ["active_version_id"] });

    // event_department: depends only on production
    await add("event_department", `production_id IN (${idList})`, [], { ciNullCols: CI_NULL_CHAT_ID });

    // ── TIER 2: deps on production + version (version deps on production) ────

    await add("version", `production_id IN (${idList})`, []);

    // production_member: deps production + feishu_user
    await add("production_member", `production_id IN (${idList})`, [], { ciNullCols: CI_NULL_PROD_MEMBER });

    // production_member_permission: deps production_member
    await add("production_member_permission", `production_id IN (${idList})`, []);

    // cue_list: deps production + feishu_user (created_by = open_id)
    await add("cue_list", `production_id IN (${idList})`, []);

    // ── TIER 3: deps on cue_list / version / scene / character / tag_group ───

    // cue_list_permission: deps cue_list + feishu_user
    await add("cue_list_permission", `cue_list_id IN (SELECT id FROM cue_list WHERE production_id IN (${idList}))`, []);

    // scene: deps production
    await add("scene", `production_id IN (${idList})`, [], { skipCols: ["archived"] });

    // character: deps production
    await add("character", `production_id IN (${idList})`, [], { skipCols: ["archived"] });

    // character_aggregate: deps character
    await add("character_aggregate",
      `aggregate_id IN (SELECT id FROM character WHERE production_id IN (${idList}))`, []);

    // tag_group: circular FK with tag_option — null them, restore in footer
    await add("tag_group", `production_id IN (${idList})`, [],
      { nullCols: ["default_option_id", "lyric_split_after_option_id"] });

    // tag_option: deps tag_group
    await add("tag_option",
      `group_id IN (SELECT id FROM tag_group WHERE production_id IN (${idList}))`, []);

    // scene_version / character_version: deps scene/character + version
    await add("scene_version", vSub, []);
    await add("character_version", vSub, []);

    // script: deps production
    await add("script", `production_id IN (${idList})`, []);

    // script_character: deps script + character
    await add("script_character",
      `script_id IN (SELECT id FROM script WHERE production_id IN (${idList}))`, []);

    // script_version: deps version
    await add("script_version", vSub, []);

    // block_tag: deps script + tag_option
    await add("block_tag",
      `block_id IN (SELECT DISTINCT block_id FROM script WHERE production_id IN (${idList}))`, []);

    // cue / cue_version
    await add("cue", cueSub, []);
    await add("cue_version", `${vSub} AND revision_id IN (SELECT id FROM cue WHERE ${cueSub})`, []);

    // comment: deps production + feishu_user (open_id)
    await add("comment", `production_id IN (${idList})`, []);

    // notification_subscription: CI only (global table, skip in demo)
    if (ciMode) {
      await add("notification_subscription", "TRUE", []);
    }

    // ── TIER 4: production_event and its subtables ───────────────────────────

    // production_event: deps production + feishu_user + version
    await add("production_event", `production_id IN (${idList})`, [], { ciNullCols: CI_NULL_CHAT_ID });

    // event_department_member: deps event_department + feishu_user
    await add("event_department_member", deptSub, []);

    // event_stage_manager: deps production_event + feishu_user
    await add("event_stage_manager", evSub, []);

    // event_participant: deps production_event + feishu_user
    await add("event_participant", evSub, []);

    // event_schedule_item: deps production_event
    await add("event_schedule_item", evSub, []);

    // schedule_item_participant: deps event_schedule_item + feishu_user
    await add("schedule_item_participant", sitemSub, []);

    // schedule_item_department: deps event_schedule_item + event_department
    await add("schedule_item_department", sitemSub, []);

    // event_call_time: deps production_event + feishu_user + event_schedule_item
    await add("event_call_time", evSub, []);

    // event_tech_req: deps production_event + event_schedule_item
    await add("event_tech_req", evSub, [], { ciNullCols: CI_NULL_CHAT_ID });

    // event_tech_req_item: deps event_tech_req + event_schedule_item
    await add("event_tech_req_item", treqSub, []);

    // event_tech_assignee: deps event_tech_req + feishu_user
    await add("event_tech_assignee", treqSub, []);

    // event_report: deps production_event + feishu_user
    await add("event_report", evSub, []);

    // event_report_read: deps event_report + feishu_user
    await add("event_report_read", rptSub, []);

    // event_report_reply: deps event_report + feishu_user
    await add("event_report_reply", rptSub, []);

    // event_report_note: deps event_report + event_department + feishu_user
    await add("event_report_note", rptSub, []);

    // ── TIER 5: asset tables ─────────────────────────────────────────────────

    // asset: deps production + feishu_user (uploader_open_id); include universal assets too
    await add("asset", `production_id IN (${idList}) OR is_universal = TRUE`, [],
      { ciNullCols: CI_NULL_ASSET });

    // asset_file: deps asset
    await add("asset_file",
      `asset_id IN (SELECT id FROM asset WHERE production_id IN (${idList}) OR is_universal = TRUE)`, [],
      { ciNullCols: CI_NULL_ASSET_FILE });

    // asset_mount: deps asset + feishu_user + version
    await add("asset_mount",
      `asset_id IN (SELECT id FROM asset WHERE production_id IN (${idList}) OR is_universal = TRUE)`, []);

    // asset_version_rel: deps asset + version
    await add("asset_version_rel",
      `asset_id IN (SELECT id FROM asset WHERE production_id IN (${idList}) OR is_universal = TRUE)`, []);

    // ── Assemble SQL ─────────────────────────────────────────────────────────

    // In CI mode: two-pass anonymization.
    // Pass 1: replace every real open_id (ou_xxx) with its fake seed-user-N.
    //         Covers all columns and JSONB fields uniformly.
    // Pass 2: fix JSONB "openId" keys whose value is a display name rather than
    //         a proper open_id (data quality bug where the app stored the name
    //         instead of the id). The global pass won't catch these because they
    //         are not in ou_xxx format.
    let sectionsStr = sections.join("\n");
    if (ciMode) {
      for (const [realId, fakeId] of openIdMap) {
        sectionsStr = sectionsStr.replaceAll(realId, fakeId);
      }
      // Pass 2: replace "openId":"<real name>" → "openId":"<seed-user-N>"
      // Only targets the JSON key pattern to avoid accidentally replacing
      // name values in other contexts (e.g. the "name" column itself).
      for (const [realName, fakeId] of nameToFakeId) {
        const escaped = realName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        sectionsStr = sectionsStr.replace(
          new RegExp(`("openId"\\s*:\\s*")${escaped}(")`,"g"),
          `$1${fakeId}$2`
        );
      }
    }

    // ── Header: DELETE in reverse-dependency order ───────────────────────────
    const schemaContent = readFileSync(path.join(process.cwd(), "db/schema.sql"));
    const schemaHash = crypto.createHash("sha256").update(schemaContent).digest("hex");

    // CI: delete seed rows only (identified by fake open_id prefix)
    // Demo: delete production-scoped rows only; global tables (feishu_user, bot_testers,
    //        notification_subscription) are left untouched so local data isn't clobbered.
    //
    // notification_subscription: old schema uses open_id PK; new schema uses user_id PK.
    const notifSubDelete = hasAppUser
      ? `DELETE FROM notification_subscription WHERE user_id IN (SELECT user_id FROM feishu_user WHERE open_id LIKE 'seed-user-%');`
      : `DELETE FROM notification_subscription WHERE open_id LIKE 'seed-user-%';`;
    const appUserDelete = hasAppUser
      ? `DELETE FROM app_user WHERE id IN (SELECT user_id FROM feishu_user WHERE open_id LIKE 'seed-user-%');`
      : `-- app_user: not present in old schema`;
    const ciGlobalDelete = [
      notifSubDelete,
      `DELETE FROM bot_testers WHERE open_id LIKE 'seed-user-%';`,
      `DELETE FROM feishu_user WHERE open_id LIKE 'seed-user-%';`,
      appUserDelete,
    ].join("\n");

    const header = [
      `-- ${ciMode ? "CI test" : "Demo"} seed data`,
      `-- Productions: ${pidRes.rows.map((r) => r.name).join(", ")}`,
      `-- Generated: ${new Date().toISOString()}`,
      ...(ciMode ? [`-- schema-hash: ${schemaHash}`] : []),
      ``,
      `-- Delete in reverse-dependency order`,
      `DELETE FROM asset_version_rel WHERE asset_id IN (SELECT id FROM asset WHERE production_id IN (${idList}) OR is_universal = TRUE);`,
      `DELETE FROM asset_mount       WHERE asset_id IN (SELECT id FROM asset WHERE production_id IN (${idList}) OR is_universal = TRUE);`,
      `DELETE FROM asset_file        WHERE asset_id IN (SELECT id FROM asset WHERE production_id IN (${idList}) OR is_universal = TRUE);`,
      `DELETE FROM asset             WHERE production_id IN (${idList}) OR is_universal = TRUE;`,
      `DELETE FROM event_report_note  WHERE ${rptSub};`,
      `DELETE FROM event_report_reply WHERE ${rptSub};`,
      `DELETE FROM event_report_read  WHERE ${rptSub};`,
      `DELETE FROM event_report       WHERE ${evSub};`,
      `DELETE FROM event_tech_assignee WHERE ${treqSub};`,
      `DELETE FROM event_tech_req_item WHERE ${treqSub};`,
      `DELETE FROM event_tech_req      WHERE ${evSub};`,
      `DELETE FROM event_call_time     WHERE ${evSub};`,
      `DELETE FROM schedule_item_department WHERE ${sitemSub};`,
      `DELETE FROM schedule_item_participant WHERE ${sitemSub};`,
      `DELETE FROM event_schedule_item  WHERE ${evSub};`,
      `DELETE FROM event_participant    WHERE ${evSub};`,
      `DELETE FROM event_stage_manager  WHERE ${evSub};`,
      `DELETE FROM event_department_member WHERE ${deptSub};`,
      `DELETE FROM production_event WHERE production_id IN (${idList});`,
      `DELETE FROM comment WHERE production_id IN (${idList});`,
      `DELETE FROM cue_version WHERE ${vSub};`,
      `DELETE FROM cue WHERE ${cueSub};`,
      `DELETE FROM cue_list_permission WHERE cue_list_id IN (SELECT id FROM cue_list WHERE production_id IN (${idList}));`,
      `DELETE FROM block_tag WHERE block_id IN (SELECT DISTINCT block_id FROM script WHERE production_id IN (${idList}));`,
      `DELETE FROM script_version WHERE ${vSub};`,
      `DELETE FROM script_character WHERE script_id IN (SELECT id FROM script WHERE production_id IN (${idList}));`,
      `DELETE FROM script WHERE production_id IN (${idList});`,
      `DELETE FROM character_version WHERE ${vSub};`,
      `DELETE FROM scene_version WHERE ${vSub};`,
      `UPDATE tag_group SET default_option_id = NULL, lyric_split_after_option_id = NULL WHERE production_id IN (${idList});`,
      `DELETE FROM tag_option WHERE group_id IN (SELECT id FROM tag_group WHERE production_id IN (${idList}));`,
      `DELETE FROM tag_group WHERE production_id IN (${idList});`,
      `DELETE FROM character_aggregate WHERE aggregate_id IN (SELECT id FROM character WHERE production_id IN (${idList}));`,
      `DELETE FROM character WHERE production_id IN (${idList});`,
      `DELETE FROM scene WHERE production_id IN (${idList});`,
      `DELETE FROM cue_list WHERE production_id IN (${idList});`,
      `DELETE FROM production_member_permission WHERE production_id IN (${idList});`,
      `DELETE FROM production_member WHERE production_id IN (${idList});`,
      `DELETE FROM event_department WHERE production_id IN (${idList});`,
      `UPDATE production SET active_version_id = NULL WHERE id IN (${idList});`,
      `DELETE FROM version WHERE production_id IN (${idList});`,
      `DELETE FROM production WHERE id IN (${idList});`,
      ...(ciMode ? [ciGlobalDelete] : []),
      ``,
    ].join("\n");

    // ── Footer: restore circular FKs ─────────────────────────────────────────
    const prodRows = await client.query<{ id: string; active_version_id: string | null }>(
      `SELECT id, active_version_id FROM production WHERE id = ANY($1)`, [pids]
    );
    const tgRows = await client.query<{ id: string; default_option_id: string | null; lyric_split_after_option_id: string | null }>(
      `SELECT id, default_option_id, lyric_split_after_option_id FROM tag_group WHERE production_id = ANY($1)`, [pids]
    );
    const restoreLines: string[] = [];
    for (const r of prodRows.rows) {
      if (r.active_version_id)
        restoreLines.push(`UPDATE production SET active_version_id = '${r.active_version_id}' WHERE id = '${r.id}';`);
    }
    for (const r of tgRows.rows) {
      const sets: string[] = [];
      if (r.default_option_id) sets.push(`default_option_id = '${r.default_option_id}'`);
      if (r.lyric_split_after_option_id) sets.push(`lyric_split_after_option_id = '${r.lyric_split_after_option_id}'`);
      if (sets.length) restoreLines.push(`UPDATE tag_group SET ${sets.join(", ")} WHERE id = '${r.id}';`);
    }
    const footer = restoreLines.length
      ? `\n-- Restore circular FK columns\n${restoreLines.join("\n")}\n`
      : "";

    const sql = header + sectionsStr + footer;
    const buf = Buffer.from(sql, "utf-8");
    const R2_KEY = ciMode ? "seed-data/ci.sql" : "seed-data/demo.sql";
    console.log(`Uploading to R2 bucket "${process.env.SEED_R2_BUCKET}": ${R2_KEY} (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
    await uploadSeed(R2_KEY, buf);
    console.log(`Done. ${ciMode ? "CI seed uploaded — includes all tables, open_ids anonymized." : "Testers can now run: npm run seed:demo"}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
