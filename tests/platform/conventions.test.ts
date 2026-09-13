/**
 * Forward-looking convention enforcement tests.
 *
 * These tests do NOT audit current code correctness — they assert invariants
 * that must hold as the codebase evolves, so future code changes that violate
 * them are caught at CI time.
 *
 * Invariants:
 *  1. No runtime DDL in application code  (static file scan)
 *  2. Schema fingerprint matches seed     (schema drift detection)
 *
 * 曾经的 2「运行时 migration 幂等性」已随最后一支运行时 migration
 * (ensureScriptMarkerMigration, commit 2110bb1) 一同退役——现在一条都没有，
 * 存量数据一律走 db/migrate-*.sql。真要新增，先补回这一节（见 DEV_GUIDE §11.5 ②）。
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
// 2. Schema fingerprint — detect seed vs schema drift
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
    // 覆盖面依据：lib/production/templates/ 下除 shared.ts 外的 7 个模版文件全部注册在
    // PRODUCTION_TEMPLATES；shared.ts 是纯积木模块（被 7 个模版 import），
    // 自身不独立发键。故审计 PRODUCTION_TEMPLATES 即审计全部模版键源。
    // 若未来新增模版文件而忘了注册，resolveTemplate 也拿不到它——注册表
    // 就是运行时的唯一取用面，不存在绕过审计又能生效的键源。
    const { PRODUCTION_TEMPLATES } = await import("@/lib/production/production-template");

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

// ─────────────────────────────────────────────────────────────────────────────
// tests/ 目录形态棘轮（#472）
// ─────────────────────────────────────────────────────────────────────────────
// 297 个文件平铺过一次，整理成域目录后不许回退。规则只钉形态、不钉目录名单——
// 新开一个域目录不用改这里，但「顺手丢在根目录」和「域下再套一层」都会红。
// 域目录的清单与归属原则见 DEV_GUIDE §11.2。

describe("tests/ 按域分目录，不回退成平铺", () => {
  const TESTS_ROOT = path.join(ROOT, "tests");
  const isTestFile = (name: string) => /\.test\.tsx?$/.test(name);

  it("根目录下没有测试文件——新测试必须进域目录", async () => {
    const entries = await readdir(TESTS_ROOT, { withFileTypes: true });
    const strays = entries.filter((e) => e.isFile() && isTestFile(e.name)).map((e) => e.name);
    expect(strays, "tests/ 根目录出现了测试文件，请移到对应域目录").toEqual([]);
  });

  it("域目录只有一层：测试文件不落在 tests/<domain>/ 之下的子目录里", async () => {
    const deep: string[] = [];
    for (const d of await readdir(TESTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const e of await readdir(path.join(TESTS_ROOT, d.name), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const walk = async (dir: string): Promise<void> => {
          for (const f of await readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) await walk(full);
            else if (isTestFile(f.name)) deep.push(path.relative(TESTS_ROOT, full));
          }
        };
        await walk(path.join(TESTS_ROOT, d.name, e.name));
      }
    }
    expect(deep).toEqual([]);
  });

  it("_support/ 只放支撑件，不放测试", async () => {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const f of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, f.name);
        if (f.isDirectory()) await walk(full);
        else if (isTestFile(f.name)) found.push(path.relative(TESTS_ROOT, full));
      }
    };
    await walk(path.join(TESTS_ROOT, "_support"));
    expect(found).toEqual([]);
  });

  it("migration 三件套住在 migrations/：*.migration.test.ts 与 *-snapshot.ts 不散落到别的域", async () => {
    const strays: string[] = [];
    for (const d of await readdir(TESTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === "migrations") continue;
      for (const f of await readdir(path.join(TESTS_ROOT, d.name))) {
        if (/\.migration\.test\.tsx?$/.test(f) || /-snapshot\.ts$/.test(f)) strays.push(`${d.name}/${f}`);
      }
    }
    expect(strays).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/ 目录形态棘轮（#482）
// ─────────────────────────────────────────────────────────────────────────────
// 124 个文件靠文件名前缀平铺过一次，收进域目录后不许回退。与 tests/ 的形态棘轮
// 不同，这里钉的是一份**根目录白名单**：根只留跨域基建，任何业务文件都有它的域。
// 新开域目录不用改这里；往根加文件必须同时加白名单并更新 DEV_GUIDE §11.2 的归属表。

describe("lib/ 按域分目录，根只留基建", () => {
  const LIB_ROOT = path.join(ROOT, "lib");
  const ROOT_INFRA = [
    "db.ts", "pg.ts", "r2.ts", "server-cache.ts",
    "tz.ts", "money.ts", "duration.ts", "lex-order.ts", "z-index.ts",
    "base-path.ts", "server-url.ts", "request-json.ts", "sse-keepalive.ts",
    "nav-pending.ts", "search-db.ts",
  ];

  it("根目录文件 ⊆ 基建白名单——业务文件进域目录", async () => {
    const entries = await readdir(LIB_ROOT, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const strays = files.filter((f) => !ROOT_INFRA.includes(f));
    expect(strays, "lib/ 根目录出现了白名单之外的文件，请移到对应域目录（DEV_GUIDE §11.2）").toEqual([]);
  });

  it("白名单没有幽灵条目——移走或删除的基建文件要同步从白名单摘掉", async () => {
    const entries = await readdir(LIB_ROOT, { withFileTypes: true });
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const ghosts = ROOT_INFRA.filter((f) => !files.has(f));
    expect(ghosts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// components/ 目录形态棘轮（#482 / #487）
// ─────────────────────────────────────────────────────────────────────────────
// 104 个文件平铺过一次，三分（ui 原语 / 页面容器按域 / admin）之后不许回退。
// 只钉形态不钉名单：根目录不放文件、文件名两种形态之一。
// 域下允许**一层**「组件族」目录（#487）：巨石组件拆出来的子件 / hook / 纯函数收进
// components/<domain>/<family>/，族目录名 kebab-case = 主组件名，族内不再套目录。
// 域目录清单与归属原则见 DEV_GUIDE §11.2。

const FILE_NAME_OK = /^(?:[A-Z][A-Za-z0-9]*|[a-z0-9]+(?:-[a-z0-9]+)*)(?:\.module)?\.(?:tsx?|css)$/;
const FAMILY_DIR_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe("components/ 按域分目录，不回退成平铺", () => {
  const COMPONENTS_ROOT = path.join(ROOT, "components");

  it("根目录没有文件——组件必须进域目录（通用原语进 ui/，壳进 shell/）", async () => {
    const entries = await readdir(COMPONENTS_ROOT, { withFileTypes: true });
    const strays = entries.filter((e) => e.isFile()).map((e) => e.name);
    expect(strays, "components/ 根目录出现了文件，请移到对应域目录（DEV_GUIDE §11.2）").toEqual([]);
  });

  it("域下最多一层组件族目录：族目录名 kebab-case，族目录下没有子目录", async () => {
    const badFamilyName: string[] = [];
    const deep: string[] = [];
    for (const d of await readdir(COMPONENTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const e of await readdir(path.join(COMPONENTS_ROOT, d.name), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (!FAMILY_DIR_OK.test(e.name)) badFamilyName.push(`${d.name}/${e.name}`);
        for (const f of await readdir(path.join(COMPONENTS_ROOT, d.name, e.name), { withFileTypes: true })) {
          if (f.isDirectory()) deep.push(`${d.name}/${e.name}/${f.name}`);
        }
      }
    }
    expect(badFamilyName, "组件族目录名必须 kebab-case（= 主组件名）").toEqual([]);
    expect(deep, "组件族目录下不再套目录").toEqual([]);
  });

  it("文件名两种形态：组件 PascalCase.tsx；hook / context / util 与样式 kebab-case", async () => {
    // PascalCase 给默认导出一个组件的文件（含其 .module.css）；kebab-case 给
    // 非组件模块（use-fonts-settled.ts、ai-target.tsx、watermark-tile.ts）与共享样式。
    const bad: string[] = [];
    for (const d of await readdir(COMPONENTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const e of await readdir(path.join(COMPONENTS_ROOT, d.name), { withFileTypes: true })) {
        if (e.isDirectory()) {
          for (const f of await readdir(path.join(COMPONENTS_ROOT, d.name, e.name))) {
            if (!FILE_NAME_OK.test(f)) bad.push(`${d.name}/${e.name}/${f}`);
          }
        } else if (!FILE_NAME_OK.test(e.name)) {
          bad.push(`${d.name}/${e.name}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 巨石组件行数棘轮（#487）
// ─────────────────────────────────────────────────────────────────────────────
// 五个巨石文件只降不升：每次拆分 PR 把这里的数字改小。
// 拆出来的文件（组件族目录内）有上限：组件 ≤ 800、hook ≤ 400；两个整块搬出来时就超标
// 的子件按当前行数记账，同样只降不升——它们自己的瘦身不在 #487 范围。

const MONOLITH_LINE_CEILING: Record<string, number> = {
  "components/script/ScriptEditor.tsx": 12316,
  "components/ops/EventDetailClient.tsx": 3538,
  "components/ops/CuePage.tsx": 3210,
  "components/ops/PlanningClient.tsx": 2586,
  "components/shell/AppShell.tsx": 1090,
};

const FAMILY_FILE_CEILING = { component: 800, hook: 400 } as const;

/** 整块搬出即超标的子件：按搬出时的行数记账，只降不升。 */
const FAMILY_FILE_GRANDFATHERED: Record<string, number> = {
  "components/script/script-editor/ScriptBlock.tsx": 1096,
  "components/ops/planning/TimetableView.tsx": 943,
};

/** 与 `wc -l` 同口径（数换行符），表里的数字可以直接对着终端核。 */
async function countLines(rel: string): Promise<number> {
  const text = await readFile(path.join(ROOT, rel), "utf-8");
  return (text.match(/\n/g) ?? []).length;
}

describe("巨石组件行数只降不升", () => {
  for (const [rel, ceiling] of Object.entries(MONOLITH_LINE_CEILING)) {
    it(`${rel} ≤ ${ceiling} 行`, async () => {
      const lines = await countLines(rel);
      expect(lines, `${rel} 长了。拆分 PR 请同时把 MONOLITH_LINE_CEILING 改小；功能 PR 不该让它增长`).toBeLessThanOrEqual(ceiling);
    });
  }

  it("组件族目录内的文件：组件 ≤ 800 行、hook ≤ 400 行（记账豁免见 FAMILY_FILE_GRANDFATHERED）", async () => {
    const COMPONENTS_ROOT = path.join(ROOT, "components");
    const over: string[] = [];
    for (const d of await readdir(COMPONENTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const e of await readdir(path.join(COMPONENTS_ROOT, d.name), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        for (const f of await readdir(path.join(COMPONENTS_ROOT, d.name, e.name))) {
          if (!/\.tsx?$/.test(f)) continue;
          const rel = `components/${d.name}/${e.name}/${f}`;
          const lines = await countLines(rel);
          const ceiling = FAMILY_FILE_GRANDFATHERED[rel]
            ?? (f.startsWith("use-") ? FAMILY_FILE_CEILING.hook : FAMILY_FILE_CEILING.component);
          if (lines > ceiling) over.push(`${rel}: ${lines} > ${ceiling}`);
        }
      }
    }
    expect(over).toEqual([]);
  });
});
