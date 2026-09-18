import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadManual, getManualNeighbors, manualRouteIndex, ManualContentError,
  extractHeadings, slugifyHeading, HeadingIds, resolveManualLink, extractBodyRefs,
} from "@/lib/help/manual";

// 手册加载器（#531）：目录即信息架构。这里用临时目录造一棵小树，验证排序、
// 上下页、路由索引与各类作者错误的报错面；仓库真实内容的校验在 manual-coverage.test.ts。

let root: string;

async function put(rel: string, text: string) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}
const fm = (fields: Record<string, string | number>, body = "") =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "manual-"));
  await put("_home.md", fm({ quickstart: "[b/g1/one]", popular: "[]" }));
  await put("_TEMPLATE.md", "not a page");
  await put("b/_index.md", fm({ title: "乙", order: 2 }));
  await put("a/_index.md", fm({ title: "甲", order: 1, summary: "第一部分" }));
  await put("a/g2/_index.md", fm({ title: "组二", order: 2 }));
  await put("a/g1/_index.md", fm({ title: "组一", order: 1 }));
  await put("a/g1/two.md", fm({ title: "第二篇", order: 2, routes: "[cues, cuelists]" }, "## 步骤\n### 子步骤\n```\n## 代码里的不是标题\n```\n## 步骤\n"));
  await put("a/g1/one.md", fm({ title: "第一篇", order: 1, routes: "[cues]", tier: "pro", platform: "[desktop]" }));
  await put("a/g1/_draft.md", fm({ title: "下划线开头不是页面" }));
  await put("a/g2/three.md", fm({ title: "第三篇" }));
  await put("b/g1/_index.md", fm({ title: "乙组" }));
  await put("b/g1/one.md", fm({ title: "乙一", related: "[a/g1/one]" }));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("loadManual", () => {
  it("一级 / 二级 / 文章按 order 排序，下划线文件不是页面", () => {
    const m = loadManual(root);
    expect(m.sections.map((s) => s.title)).toEqual(["甲", "乙"]);
    expect(m.sections[0].groups.map((g) => g.title)).toEqual(["组一", "组二"]);
    expect(m.pages.map((p) => p.slug)).toEqual(["a/g1/one", "a/g1/two", "a/g2/three", "b/g1/one"]);
    expect(m.sections[0].summary).toBe("第一部分");
    expect(m.home.quickstart).toEqual(["b/g1/one"]);
  });

  it("frontmatter 缺省：tier=all、platform=两端；显式值原样", () => {
    const m = loadManual(root);
    const one = m.pages.find((p) => p.slug === "a/g1/one")!;
    const three = m.pages.find((p) => p.slug === "a/g2/three")!;
    expect(one.tier).toBe("pro");
    expect(one.platform).toEqual(["desktop"]);
    expect(three.tier).toBe("all");
    expect(three.platform).toEqual(["desktop", "mobile"]);
    expect(three.who).toBeNull();
  });

  it("上下页沿导航顺序跨组跨一级", () => {
    expect(getManualNeighbors("a/g1/one", root).prev).toBeNull();
    expect(getManualNeighbors("a/g1/one", root).next?.slug).toBe("a/g1/two");
    expect(getManualNeighbors("a/g2/three", root).next?.slug).toBe("b/g1/one");
    expect(getManualNeighbors("b/g1/one", root).next).toBeNull();
    expect(getManualNeighbors("nope", root)).toEqual({ prev: null, next: null });
  });

  it("路由索引：同一路由多篇声明时取导航顺序里的第一篇", () => {
    const idx = manualRouteIndex(loadManual(root));
    expect(idx.get("cues")).toBe("a/g1/one");
    expect(idx.get("cuelists")).toBe("a/g1/two");
  });

  it("标题抽取跳过围栏代码，重复标题去重", () => {
    const two = loadManual(root).pages.find((p) => p.slug === "a/g1/two")!;
    expect(two.headings).toEqual([
      { id: "步骤", text: "步骤", depth: 2 },
      { id: "子步骤", text: "子步骤", depth: 3 },
      { id: "步骤-2", text: "步骤", depth: 2 },
    ]);
  });
});

describe("loadManual：作者错误报错面", () => {
  async function withTree(setup: (r: string) => Promise<void>): Promise<() => void> {
    const r = await mkdtemp(path.join(os.tmpdir(), "manual-bad-"));
    await setup(r);
    return () => loadManual(r);
  }
  const p = (r: string) => async (rel: string, text: string) => {
    const file = path.join(r, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  };

  it("分组目录缺 _index.md", async () => {
    const run = await withTree(async (r) => { await p(r)("a/g/x.md", fm({ title: "x" })); });
    expect(run).toThrow(ManualContentError);
    expect(run).toThrow(/_index\.md/);
  });
  it("文章缺 title", async () => {
    const run = await withTree(async (r) => {
      await p(r)("a/_index.md", fm({ title: "a" })); await p(r)("a/g/_index.md", fm({ title: "g" }));
      await p(r)("a/g/x.md", fm({ order: 1 }));
    });
    expect(run).toThrow(/缺少 title/);
  });
  it("tier / platform / updated 取值非法", async () => {
    const base = async (r: string) => { await p(r)("a/_index.md", fm({ title: "a" })); await p(r)("a/g/_index.md", fm({ title: "g" })); };
    expect(await withTree(async (r) => { await base(r); await p(r)("a/g/x.md", fm({ title: "x", tier: "gold" })); })).toThrow(/tier 只能是/);
    expect(await withTree(async (r) => { await base(r); await p(r)("a/g/x.md", fm({ title: "x", platform: "[tv]" })); })).toThrow(/platform 只能是/);
    expect(await withTree(async (r) => { await base(r); await p(r)("a/g/x.md", fm({ title: "x", updated: "2026/9/18" })); })).toThrow(/updated 要写/);
  });
  it("二级下再套目录", async () => {
    const run = await withTree(async (r) => {
      await p(r)("a/_index.md", fm({ title: "a" })); await p(r)("a/g/_index.md", fm({ title: "g" }));
      await p(r)("a/g/deeper/_index.md", fm({ title: "d" }));
    });
    expect(run).toThrow(/不允许再建目录/);
  });
  it("frontmatter 语法错误带文件名", async () => {
    const run = await withTree(async (r) => {
      await p(r)("a/_index.md", fm({ title: "a" })); await p(r)("a/g/_index.md", fm({ title: "g" }));
      await p(r)("a/g/x.md", "---\ntitle: x\nroutes:\n  - a\n---\n");
    });
    expect(run).toThrow(/x\.md: frontmatter 第 4 行/);
  });
});

describe("锚点与链接解析", () => {
  it("slugifyHeading 保留中文，空白折成 -，去掉标点", () => {
    expect(slugifyHeading("用飞书登录")).toBe("用飞书登录");
    expect(slugifyHeading("Step 1: Create   Cue-list!")).toBe("step-1-create-cue-list");
    expect(slugifyHeading("`code` 与 **粗体**")).toBe("code-与-粗体");
    expect(slugifyHeading("???")).toBe("section");
  });
  it("HeadingIds 同页去重从 -2 起", () => {
    const ids = new HeadingIds();
    expect([ids.next("步骤"), ids.next("步骤"), ids.next("步骤")]).toEqual(["步骤", "步骤-2", "步骤-3"]);
  });
  it("extractHeadings 只认 h2/h3，去掉行内 markdown", () => {
    expect(extractHeadings("# h1\n## [链接](x) 与 `码`\n#### h4\n### **粗**")).toEqual([
      { id: "链接-与-码", text: "链接 与 码", depth: 2 },
      { id: "粗", text: "粗", depth: 3 },
    ]);
  });
  it("resolveManualLink：/help 绝对、相对、同组；外链 / 锚点 / 其它站内路径为 null", () => {
    expect(resolveManualLink("creation/cues/create", "/help/creation/cues/link#步骤")).toBe("creation/cues/link");
    expect(resolveManualLink("creation/cues/create", "../script/edit.md")).toBe("creation/script/edit");
    expect(resolveManualLink("creation/cues/create", "link")).toBe("creation/cues/link");
    expect(resolveManualLink("creation/cues/create", "./link")).toBe("creation/cues/link");
    expect(resolveManualLink("creation/cues/create", "https://example.com")).toBeNull();
    expect(resolveManualLink("creation/cues/create", "#步骤")).toBeNull();
    expect(resolveManualLink("creation/cues/create", "/login")).toBeNull();
  });
  it("extractBodyRefs 区分链接与图片，跳过代码", () => {
    const { links, images } = extractBodyRefs("[a](x) ![图](/manual/p.png) `[c](y)`\n```\n[d](z)\n```");
    expect(links).toEqual(["x"]);
    expect(images).toEqual(["/manual/p.png"]);
  });
});
