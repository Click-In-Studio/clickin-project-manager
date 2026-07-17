/**
 * Forward-looking convention enforcement tests.
 *
 * These tests do NOT audit current code correctness — they assert invariants
 * that must hold as the codebase evolves, so future code changes that violate
 * them are caught at CI time.
 *
 * Three invariants:
 *  1. No runtime DDL in application code  (static file scan)
 *  2. Runtime migrations are idempotent   (run twice → no side effects)
 *  3. Schema fingerprint matches seed     (schema drift detection)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/pg";
import { ensureScriptMarkerMigration } from "@/lib/db";
import { makeProduction, cleanupProduction } from "./factories";

// ─────────────────────────────────────────────────────────────────────────────
// 1. No runtime DDL in application source
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(process.cwd());

/** Directories containing application logic that must not issue DDL at runtime. */
const SCAN_DIRS = ["lib", "app/api"];

/** DDL patterns that must not appear in executed SQL strings. */
const DDL_PATTERNS = [
  /\bALTER\s+TABLE\b/i,
  /\bCREATE\s+TABLE\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bALTER\s+TYPE\b/i,
];

/**
 * Line-level exceptions:
 *  - Lines inside `.replace(/.../)` calls — these are *stripping* DDL from SQL, not emitting it
 *  - Lines with the escape comment `// ddl-check-ignore`
 *  - Pure comment lines
 */
function shouldSkipLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("//")) return true;
  if (t.includes("ddl-check-ignore")) return true;
  if (t.match(/\.replace\s*\(\s*\//)) return true; // regex arg to .replace()
  return false;
}

/** Recursively list .ts files under a directory, skipping node_modules / .next. */
async function listTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !["node_modules", ".next", ".git"].includes(e.name)) {
      out.push(...await listTs(full));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no runtime DDL in application source", () => {
  it("lib/ and app/api/ contain no executed DDL statements", async () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) {
      files.push(...await listTs(path.join(ROOT, dir)));
    }

    const violations: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      // Track whether we're inside a template literal (heuristic: open backtick count)
      let inTemplateLiteral = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (shouldSkipLine(line)) continue;

        // Toggle template literal state
        const backtickCount = (line.match(/`/g) ?? []).length;
        if (backtickCount % 2 !== 0) inTemplateLiteral = !inTemplateLiteral;

        // We flag a line if it contains a DDL keyword AND appears in a SQL context:
        // either inside a template literal, or on a line with .query( / pool.query(
        const inQueryCall = /(?:pool|client|getPool\(\))\.query\s*\(/.test(line);
        if (!inTemplateLiteral && !inQueryCall) continue;

        for (const pattern of DDL_PATTERNS) {
          if (pattern.test(line)) {
            const rel = path.relative(ROOT, file);
            violations.push(`${rel}:${i + 1}  ${line.trim().substring(0, 120)}`);
            break;
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `DDL found in runtime application code. Add "// ddl-check-ignore" to suppress a legitimate exception.\n\n` +
        violations.map((v) => `  ${v}`).join("\n"),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Runtime migrations are idempotent
// ─────────────────────────────────────────────────────────────────────────────

let versionId: string;
let prodId: string;

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("runtime migration idempotency", () => {
  it("ensureScriptMarkerMigration: fresh version returns ready immediately (no blocks to migrate)", async () => {
    const result = await ensureScriptMarkerMigration(versionId);
    expect(result.status).toBe("ready");
  });

  it("ensureScriptMarkerMigration: idempotent — second call returns ready too", async () => {
    await ensureScriptMarkerMigration(versionId); // first call
    const result = await ensureScriptMarkerMigration(versionId); // second call
    expect(result.status).toBe("ready");
  });

  it("ensureScriptMarkerMigration: row count in script_version is unchanged after call", async () => {
    const before = await getPool().query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM script_version WHERE version_id = $1",
      [versionId],
    );
    await ensureScriptMarkerMigration(versionId);
    const after = await getPool().query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM script_version WHERE version_id = $1",
      [versionId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Schema fingerprint — detect seed vs schema drift
// ─────────────────────────────────────────────────────────────────────────────

type ColumnEntry = { column: string; type: string; nullable: boolean; default?: string };
type SchemaFingerprint = Record<string, ColumnEntry[]>;

describe("schema fingerprint matches committed seed-schema.json", () => {
  it("current DB structure matches db/seed-schema.json (re-run npm run seed:schema if this fails)", async () => {
    // Read committed fingerprint
    const committedRaw = await readFile(path.join(ROOT, "db/seed-schema.json"), "utf8");
    const committed: SchemaFingerprint = JSON.parse(committedRaw);

    // Query current DB structure
    const res = await getPool().query<{
      table_name: string; column_name: string;
      data_type: string; is_nullable: string; column_default: string | null;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT LIKE 'test-%'
      ORDER BY table_name, ordinal_position
    `);

    const actual: SchemaFingerprint = {};
    for (const r of res.rows) {
      if (!actual[r.table_name]) actual[r.table_name] = [];
      const entry: ColumnEntry = {
        column: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES",
      };
      if (r.column_default) entry.default = r.column_default.substring(0, 80);
      actual[r.table_name].push(entry);
    }

    const diffs: string[] = [];

    // Tables in committed but not in actual (dropped)
    for (const table of Object.keys(committed)) {
      if (!actual[table]) {
        diffs.push(`TABLE DROPPED: ${table}`);
      }
    }
    // Tables in actual but not in committed (added — need seed re-export)
    for (const table of Object.keys(actual)) {
      if (!committed[table]) {
        diffs.push(`TABLE ADDED (re-export seed): ${table}`);
      }
    }

    // Column-level diff for shared tables
    for (const table of Object.keys(committed)) {
      if (!actual[table]) continue;
      const committedCols = new Map(committed[table].map((c) => [c.column, c]));
      const actualCols = new Map(actual[table].map((c) => [c.column, c]));

      for (const [col, info] of committedCols) {
        if (!actualCols.has(col)) {
          diffs.push(`${table}.${col}: COLUMN DROPPED`);
        } else {
          const a = actualCols.get(col)!;
          if (a.type !== info.type)
            diffs.push(`${table}.${col}: type changed ${info.type} → ${a.type}`);
          if (a.nullable !== info.nullable)
            diffs.push(`${table}.${col}: nullable changed ${info.nullable} → ${a.nullable}`);
        }
      }
      for (const col of actualCols.keys()) {
        if (!committedCols.has(col)) {
          diffs.push(`${table}.${col}: COLUMN ADDED (re-export seed)`);
        }
      }
    }

    if (diffs.length > 0) {
      throw new Error(
        `Schema has drifted from db/seed-schema.json.\n` +
        `Run "npm run seed:schema" and commit db/seed-schema.json, ` +
        `then re-export the seed with "npm run seed:ci-export".\n\n` +
        diffs.map((d) => `  ${d}`).join("\n"),
      );
    }
  });
});
