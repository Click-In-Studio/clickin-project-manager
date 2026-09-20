import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadChangelog, latestChangelogVersion, changelogForPage, groupByKind, compareVersions,
  ChangelogContentError, CHANGELOG_ROOT, CHANGELOG_UNRELEASED_DIR, CHANGELOG_KINDS,
} from "@/lib/help/changelog";
import { hasUnseenChangelog } from "@/lib/help/changelog-seen";
import { loadManual } from "@/lib/help/manual";

// 更新日志（#569）：① 临时目录造一棵小树验证加载器语义与作者错误报错面；
// ② 仓库真实内容的自洽——条目指向存在的手册页、写法不带技术味、发版流程的结构约束。

const fm = (fields: Record<string, string | number>, body = "") =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;

async function makeTree(setup: (put: (rel: string, text: string) => Promise<void>) => Promise<void>): Promise<string> {
  const r = await mkdtemp(path.join(os.tmpdir(), "changelog-"));
  await setup(async (rel, text) => {
    const file = path.join(r, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  });
  return r;
}

describe("loadChangelog：小树语义", () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTree(async (put) => {
      await put("_TEMPLATE.md", "not an entry");
      await put("unreleased/.gitkeep", "");
      await put("unreleased/900-x.md", fm({ kind: "fixed", title: "未发的修复", pr: 900 }));
      await put("v0.2/_index.md", fm({ date: "2026-09-20", summary: "第二版" }));
      await put("v0.2/_draft.md", fm({ kind: "new", title: "下划线开头不是条目" }));
      await put("v0.2/20-b.md", fm({ kind: "fixed", title: "修复乙", page: "a/b/c", pr: 20 }));
      await put("v0.2/10-a.md", fm({ kind: "new", title: "新增甲", order: 2 }, "\n补充说明\n"));
      await put("v0.2/11-c.md", fm({ kind: "new", title: "新增丙", order: 1 }));
      await put("v0.10/_index.md", fm({ date: "2026-12-01" }));
      await put("v0.1.0/_index.md", fm({ date: "2026-09-19" }));
      await put("v0.1.0/first.md", fm({ kind: "new", title: "上线", page: "a/b/c" }));
    });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("版本按号倒序（v0.10 > v0.2 > v0.1.0），unreleased 单独一组，下划线文件不算", () => {
    const log = loadChangelog(root);
    expect(log.versions.map((v) => v.version)).toEqual(["v0.10", "v0.2", "v0.1.0"]);
    expect(latestChangelogVersion(log)).toBe("v0.10");
    expect(log.unreleased.map((e) => e.id)).toEqual(["900-x"]);
    expect(log.versions[1].summary).toBe("第二版");
    expect(log.versions[1].entries.map((e) => e.id)).toEqual(["11-c", "10-a", "20-b"]);
  });

  it("条目字段：正文去首尾空白、pr / page 可缺省", () => {
    const v02 = loadChangelog(root).versions[1];
    const a = v02.entries.find((e) => e.id === "10-a")!;
    expect(a).toMatchObject({ kind: "new", title: "新增甲", order: 2, body: "补充说明", pr: null, page: null });
    expect(v02.entries.find((e) => e.id === "20-b")).toMatchObject({ pr: 20, page: "a/b/c" });
  });

  it("changelogForPage 取最近一个提到该页的已发版本；groupByKind 只出非空组", () => {
    const log = loadChangelog(root);
    const hit = changelogForPage(log, "a/b/c")!;
    expect(hit.version.version).toBe("v0.2");
    expect(hit.entries.map((e) => e.id)).toEqual(["20-b"]);
    expect(changelogForPage(log, "nope")).toBeNull();
    expect(groupByKind(log.versions[1].entries).map((g) => [g.kind, g.entries.length])).toEqual([["new", 2], ["fixed", 1]]);
  });
});

describe("loadChangelog：作者错误报错面", () => {
  const bad = async (setup: Parameters<typeof makeTree>[0]) => {
    const r = await makeTree(setup);
    return () => loadChangelog(r);
  };
  it("版本目录名不是 tag 形态", async () => {
    const run = await bad(async (put) => { await put("release-2/_index.md", fm({ date: "2026-01-01" })); });
    expect(run).toThrow(ChangelogContentError);
    expect(run).toThrow(/tag 形态/);
  });
  it("版本目录缺 _index.md / date 格式错", async () => {
    expect(await bad(async (put) => { await put("v1/x.md", fm({ kind: "new", title: "x" })); })).toThrow(/_index\.md/);
    expect(await bad(async (put) => { await put("v1/_index.md", fm({ date: "2026/1/1" })); })).toThrow(/YYYY-MM-DD/);
  });
  it("条目 kind 非法 / 缺 title / pr 不是正整数 / page 写成路径", async () => {
    const base = async (put: (rel: string, text: string) => Promise<void>) => { await put("v1/_index.md", fm({ date: "2026-01-01" })); };
    expect(await bad(async (put) => { await base(put); await put("v1/a.md", fm({ kind: "changed", title: "x" })); })).toThrow(/kind 只能是/);
    expect(await bad(async (put) => { await base(put); await put("v1/a.md", fm({ kind: "new" })); })).toThrow(/缺少 title/);
    expect(await bad(async (put) => { await base(put); await put("v1/a.md", fm({ kind: "new", title: "x", pr: "abc" })); })).toThrow(/pr 要写正整数/);
    expect(await bad(async (put) => { await base(put); await put("v1/a.md", fm({ kind: "new", title: "x", page: "/help/a/b" })); })).toThrow(/page 写手册页 slug/);
  });
});

describe("compareVersions / hasUnseenChangelog", () => {
  it("按段比较，缺段当 0", () => {
    expect(compareVersions("v0.2", "v0.10")).toBeLessThan(0);
    expect(compareVersions("v1.0", "v0.99.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.2", "v0.2.0")).toBe(0);
  });
  it("没发过版不红；看过最新的不红；版本变了红", () => {
    expect(hasUnseenChangelog(null, null)).toBe(false);
    expect(hasUnseenChangelog("v0.2", "v0.2")).toBe(false);
    expect(hasUnseenChangelog("v0.2", null)).toBe(true);
    expect(hasUnseenChangelog("v0.3", "v0.2")).toBe(true);
  });
});

// ─── 仓库真实内容 ──────────────────────────────────────────────────────────

const log = loadChangelog();
const manualSlugs = new Set(loadManual().pages.map((p) => p.slug));
const allEntries = [...log.unreleased, ...log.versions.flatMap((v) => v.entries)];

/** 给非程序员看的一句话里不该出现的东西：issue/PR 号、路径、代码标识、反引号。 */
const TECH_SMELL = [/#\d+/, /\b(lib|app|components|api|db)\//, /[`]/, /\bnode:/, /_db\b/, /\.tsx?\b/];

describe("更新日志内容自洽", () => {
  it("目录骨架在位：模板、unreleased/、至少一个已发版本", () => {
    expect(existsSync(path.join(CHANGELOG_ROOT, "_TEMPLATE.md"))).toBe(true);
    expect(existsSync(path.join(CHANGELOG_ROOT, CHANGELOG_UNRELEASED_DIR))).toBe(true);
    expect(log.versions.length).toBeGreaterThan(0);
  });

  it("每条 page 指向存在的手册页（「了解更多」不能是死链）", () => {
    const bad = allEntries.filter((e) => e.page && !manualSlugs.has(e.page)).map((e) => `${e.file} → ${e.page}`);
    expect(bad).toEqual([]);
  });

  it("unreleased/ 里的每条都写了来源 pr（发版脚本按它归档）", () => {
    expect(log.unreleased.filter((e) => e.pr === null).map((e) => e.id)).toEqual([]);
  });

  it("标题是读者的语言：不带 PR 号、路径、代码标识", () => {
    const bad = allEntries.filter((e) => TECH_SMELL.some((re) => re.test(e.title))).map((e) => `${e.id}: ${e.title}`);
    expect(bad, "见 content/changelog/_TEMPLATE.md 的写法说明").toEqual([]);
  });

  it("每条 kind 都是四种之一（加载器已拦，这里锁住词表本身没被改坏）", () => {
    expect([...CHANGELOG_KINDS]).toEqual(["new", "improved", "fixed", "removed"]);
    for (const e of allEntries) expect(CHANGELOG_KINDS).toContain(e.kind);
  });
});
