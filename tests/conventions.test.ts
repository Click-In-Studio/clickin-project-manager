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
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/pg";

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
      WHERE table_schema = current_schema()
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
        diffs.push(`TABLE ADDED (run: npm run seed:schema): ${table}`);
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
          diffs.push(`${table}.${col}: COLUMN ADDED (run: npm run seed:schema)`);
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

describe("openclaw-workspace files are fully tracked (gitignore guard)", () => {
  it("every on-disk workspace file is in git — none silently ignored", async () => {
    // #292 事故防回归：.gitignore 的裸 AGENTS.md 规则曾把
    // openclaw-workspace/AGENTS.md 静默挡在库外，CD runner 工作树缺文件、
    // scp 中止，六个 workspace 文件全没同步（deploy 仍 success 只留
    // warning）。这里断言磁盘与 git 跟踪清单一致——未来任何 .gitignore
    // 改动若再吞掉 workspace 文件，在 CI 就红，而不是在生产 CD 里静默失败。
    const { execSync } = await import("node:child_process");
    const onDisk = (await readdir(path.join(process.cwd(), "openclaw-workspace"))).filter((f) => f.endsWith(".md")).sort();
    const tracked = execSync("git ls-files openclaw-workspace/", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((p) => path.basename(p))
      .sort();
    expect(onDisk).toEqual(tracked);
    expect(tracked).toContain("AGENTS.md"); // 曾经缺席的主角单独点名
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 模版发出的每个 resource_type 都必须在权限词汇表里
// ─────────────────────────────────────────────────────────────────────────────

describe("模版 resource_type ⊆ resource_permission_level 词汇表", () => {
  // material 线上事故（2026-08-20）防回归：模版自 material 域接入起就发
  // node:material/* 键，但词汇表从未登记 material 行。键落进
  // production_role_permission（无 FK）静默通过，角色实化成员 grant 行时
  // 才撞 production_member_grant_level_fk，整个授权操作失败。
  // 本审计让「模版发键在先、词汇表登记在后」在 CI 就红，不再等线上。
  it("所有模版键（角色 + 部门静态区间）的 resource_type 均已登记", async () => {
    // 覆盖面依据：lib/templates/ 下除 shared.ts 外的 7 个模版文件全部注册在
    // PRODUCTION_TEMPLATES；shared.ts 是纯积木模块（被 7 个模版 import），
    // 自身不独立发键。故审计 PRODUCTION_TEMPLATES 即审计全部模版键源。
    // 若未来新增模版文件而忘了注册，resolveTemplate 也拿不到它——注册表
    // 就是运行时的唯一取用面，不存在绕过审计又能生效的键源。
    const { PRODUCTION_TEMPLATES } = await import("@/lib/production-template");

    const keys = new Set<string>();
    for (const template of Object.values(PRODUCTION_TEMPLATES)) {
      for (const k of template.roles.baseline) keys.add(k);
      for (const roleKeys of Object.values(template.roles.permissions)) {
        for (const k of roleKeys) keys.add(k);
      }
      for (const deptKeys of Object.values(template.deptPermissions)) {
        for (const k of deptKeys) keys.add(k);
      }
    }

    const types = new Set<string>();
    for (const key of keys) {
      const m = /^node:([a-z_]+)\//.exec(key);
      if (m) types.add(m[1]);
    }
    expect(types.size).toBeGreaterThan(0);

    const { rows } = await getPool().query<{ resource_type: string }>(
      "SELECT DISTINCT resource_type FROM resource_permission_level",
    );
    const vocabulary = new Set(rows.map((r) => r.resource_type));

    const missing = [...types].filter((t) => !vocabulary.has(t)).sort();
    expect(missing, `模版发出了词汇表未登记的 resource_type（会在角色实化时撞 FK）`).toEqual([]);
  });
});
