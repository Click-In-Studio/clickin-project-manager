// 使用手册（#531）内容源：`content/manual/` 下的 markdown 树，服务端 fs 直读。
//
// 目录即信息架构（与用户拍板的 IA 一致，见 issue #523）：
//   content/manual/<一级>/_index.md              一级分类（按用户旅程：start / creation / …）
//   content/manual/<一级>/<二级>/_index.md       二级分组（逐字对齐 nav-config 的菜单名）
//   content/manual/<一级>/<二级>/<页>.md          文章
//   content/manual/_home.md                      首页配置（三步上手 / 热门问题）
//   content/manual/_TEMPLATE.md                  作者模板，不是页面
// 下划线开头的文件不是文章。slug = 相对路径去掉 .md（`start/login/register`）。
//
// 为什么进仓库不进库：手册跟代码版本走——功能 PR 顺手改 md，部署即更新，没有
// 「线上文档落后于线上功能」的第二真相源。standalone 构建不会自动追踪 fs 读的
// 文件，next.config.ts 的 outputFileTracingIncludes 显式圈进 content/manual。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, FrontmatterError, type Frontmatter } from "./frontmatter";

export const MANUAL_ROOT = path.join(process.cwd(), "content", "manual");

/** 与 lib/account/plan.ts 的 ProductionTier 对齐，外加 all（不分档）。 */
export const MANUAL_TIERS = ["all", "free", "pro"] as const;
export type ManualTier = (typeof MANUAL_TIERS)[number];
export const MANUAL_PLATFORMS = ["desktop", "mobile"] as const;
export type ManualPlatform = (typeof MANUAL_PLATFORMS)[number];

export type ManualHeading = { id: string; text: string; depth: 2 | 3 };

export type ManualPage = {
  slug: string;
  file: string;
  sectionSlug: string;
  groupSlug: string;
  title: string;
  order: number;
  /** 一句话摘要（列表与首页卡片用），frontmatter `summary` */
  summary: string | null;
  /** 对应产品内路由 path（nav-config 口径：`cuelists` / `admin/roles` / `/my/tasks`）。 */
  routes: string[];
  /** 相关文章 slug */
  related: string[];
  who: string | null;
  tier: ManualTier;
  platform: ManualPlatform[];
  /** frontmatter `updated`（YYYY-MM-DD）；没写就不显示 */
  updated: string | null;
  body: string;
  headings: ManualHeading[];
};

export type ManualGroup = { slug: string; title: string; order: number; summary: string | null; pages: ManualPage[] };
export type ManualSection = { slug: string; title: string; order: number; summary: string | null; groups: ManualGroup[] };
export type ManualHome = { quickstart: string[]; popular: string[] };
export type Manual = {
  sections: ManualSection[];
  /** 全部文章，按导航顺序（一级 order → 二级 order → 文章 order → 标题）。 */
  pages: ManualPage[];
  home: ManualHome;
};

export class ManualContentError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

// ─── 读取 ───────────────────────────────────────────────────────────────────

let cached: Manual | null = null;

/**
 * 生产环境进程内缓存一次（内容随构建走，不会变）；开发环境每次重读，作者
 * 改 md 刷新即见。测试可传自定义 root 绕过缓存。
 *
 * 整棵树一次读完、任一页出错整体抛——**刻意的**。手册页有问题该在 CI 红掉
 * （tests/help/manual-coverage.test.ts 加载的就是仓库真实内容），而不是线上
 * 静默少一页让读者以为功能不存在。能合进 main 的内容一定加载得过。
 */
export function loadManual(root: string = MANUAL_ROOT): Manual {
  if (root === MANUAL_ROOT && process.env.NODE_ENV === "production" && cached) return cached;
  const manual = readManualTree(root);
  if (root === MANUAL_ROOT) cached = manual;
  return manual;
}

export function getManualPage(slug: string, root?: string): ManualPage | null {
  return loadManual(root).pages.find((p) => p.slug === slug) ?? null;
}

export function getManualNeighbors(slug: string, root?: string): { prev: ManualPage | null; next: ManualPage | null } {
  const { pages } = loadManual(root);
  const i = pages.findIndex((p) => p.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: pages[i - 1] ?? null, next: pages[i + 1] ?? null };
}

/** 产品内路由 → 手册页 slug（多篇声明同一路由时取导航顺序里的第一篇）。 */
export function manualRouteIndex(manual: Manual): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of manual.pages) for (const r of p.routes) if (!index.has(r)) index.set(r, p.slug);
  return index;
}

function readManualTree(root: string): Manual {
  if (!existsSync(root)) throw new ManualContentError(root, "手册目录不存在");
  const sections: ManualSection[] = [];
  for (const sec of listDirs(root)) {
    const secMeta = readIndex(path.join(root, sec));
    const groups: ManualGroup[] = [];
    for (const grp of listDirs(path.join(root, sec))) {
      const grpDir = path.join(root, sec, grp);
      const grpMeta = readIndex(grpDir);
      const pages = readdirSync(grpDir)
        .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
        .map((f) => readPage(root, path.join(grpDir, f), sec, grp))
        .sort(byOrderThenTitle);
      // 二级下不再套目录：三层是与飞书/Slack 同款的深度，再深读者就迷路了
      const nested = listDirs(grpDir);
      if (nested.length) throw new ManualContentError(grpDir, `二级分组下不允许再建目录：${nested.join(", ")}`);
      groups.push({ slug: grp, title: grpMeta.title, order: grpMeta.order, summary: grpMeta.summary, pages });
    }
    groups.sort(byOrderThenTitle);
    sections.push({ slug: sec, title: secMeta.title, order: secMeta.order, summary: secMeta.summary, groups });
  }
  sections.sort(byOrderThenTitle);
  const pages = sections.flatMap((s) => s.groups.flatMap((g) => g.pages));
  return { sections, pages, home: readHome(root) };
}

function listDirs(dir: string): string[] {
  return readdirSync(dir).filter((n) => !n.startsWith("_") && !n.startsWith(".") && statSync(path.join(dir, n)).isDirectory()).sort();
}

function byOrderThenTitle(a: { order: number; title: string }, b: { order: number; title: string }): number {
  return a.order - b.order || a.title.localeCompare(b.title, "zh");
}

type IndexMeta = { title: string; order: number; summary: string | null };

function readIndex(dir: string): IndexMeta {
  const file = path.join(dir, "_index.md");
  if (!existsSync(file)) throw new ManualContentError(file, "目录缺少 _index.md（title / order）——一级分类与二级分组都要有");
  const { data } = readFrontmatter(file);
  return { title: requireString(file, data, "title"), order: optionalNumber(file, data, "order") ?? 0, summary: optionalString(file, data, "summary") };
}

function readHome(root: string): ManualHome {
  const file = path.join(root, "_home.md");
  if (!existsSync(file)) return { quickstart: [], popular: [] };
  const { data } = readFrontmatter(file);
  return { quickstart: optionalStringList(file, data, "quickstart"), popular: optionalStringList(file, data, "popular") };
}

function readFrontmatter(file: string): { data: Frontmatter; body: string } {
  try {
    return parseFrontmatter(readFileSync(file, "utf8"));
  } catch (e) {
    if (e instanceof FrontmatterError) throw new ManualContentError(file, e.message);
    throw e;
  }
}

function readPage(root: string, file: string, sectionSlug: string, groupSlug: string): ManualPage {
  const { data, body } = readFrontmatter(file);
  const slug = path.relative(root, file).replace(/\\/g, "/").replace(/\.md$/, "");
  const tier = optionalString(file, data, "tier") ?? "all";
  if (!(MANUAL_TIERS as readonly string[]).includes(tier)) {
    throw new ManualContentError(file, `tier 只能是 ${MANUAL_TIERS.join(" / ")}，收到 ${tier}`);
  }
  const platform = optionalStringList(file, data, "platform");
  for (const p of platform) {
    if (!(MANUAL_PLATFORMS as readonly string[]).includes(p)) {
      throw new ManualContentError(file, `platform 只能是 ${MANUAL_PLATFORMS.join(" / ")}，收到 ${p}`);
    }
  }
  const updated = optionalString(file, data, "updated");
  if (updated && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new ManualContentError(file, `updated 要写 YYYY-MM-DD，收到 ${updated}`);
  return {
    slug, file, sectionSlug, groupSlug,
    title: requireString(file, data, "title"),
    order: optionalNumber(file, data, "order") ?? 0,
    summary: optionalString(file, data, "summary"),
    routes: optionalStringList(file, data, "routes"),
    related: optionalStringList(file, data, "related"),
    who: optionalString(file, data, "who"),
    tier: tier as ManualTier,
    platform: (platform.length ? platform : [...MANUAL_PLATFORMS]) as ManualPlatform[],
    updated,
    body,
    headings: extractHeadings(body),
  };
}

function requireString(file: string, data: Frontmatter, key: string): string {
  const v = data[key];
  if (typeof v !== "string" || !v.trim()) throw new ManualContentError(file, `frontmatter 缺少 ${key}`);
  return v.trim();
}
function optionalString(file: string, data: Frontmatter, key: string): string | null {
  const v = data[key];
  if (v === undefined) return null;
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") throw new ManualContentError(file, `frontmatter ${key} 应为字符串`);
  return v.trim() || null;
}
function optionalNumber(file: string, data: Frontmatter, key: string): number | null {
  const v = data[key];
  if (v === undefined) return null;
  if (typeof v !== "number") throw new ManualContentError(file, `frontmatter ${key} 应为数字`);
  return v;
}
function optionalStringList(file: string, data: Frontmatter, key: string): string[] {
  const v = data[key];
  if (v === undefined) return [];
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) throw new ManualContentError(file, `frontmatter ${key} 应为数组 [a, b]`);
  return v;
}

// ─── 标题与锚点 ─────────────────────────────────────────────────────────────
// 页内目录与正文标题的 id 必须同一算法：目录在服务端从源码算，正文在 react-markdown
// 的 heading 组件里算，两边都走 HeadingIds。围栏代码里的 `#` 不是标题。

/** 中文友好的锚点：不转拼音，保留字母数字与 CJK，空白折成 `-`。 */
export function slugifyHeading(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[`*_~\[\]()<>]/g, "")
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "section";
}

/** 同页重复标题去重：第二个起加 `-2` `-3`。每次渲染新建一个实例。 */
export class HeadingIds {
  private seen = new Map<string, number>();
  next(text: string): string {
    const base = slugifyHeading(text);
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  }
}

/** 标题里的行内 markdown 去掉（链接留文字、去强调与代码标记），与渲染出的文本一致。 */
export function plainHeadingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

export function extractHeadings(body: string): ManualHeading[] {
  const ids = new HeadingIds();
  const out: ManualHeading[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = plainHeadingText(m[2]);
    out.push({ id: ids.next(text), text, depth: m[1].length as 2 | 3 });
  }
  return out;
}

// ─── 正文引用抽取（覆盖棘轮用）────────────────────────────────────────────────

/** 正文里的站内链接与图片路径（跳过围栏代码与行内代码），供 tests/help 校验存在性。 */
export function extractBodyRefs(body: string): { links: string[]; images: string[] } {
  const stripped = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links: string[] = [];
  const images: string[] = [];
  for (const m of stripped.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    (m[1] ? images : links).push(m[2]);
  }
  return { links, images };
}

/**
 * 把正文里的链接目标解析成手册 slug；不是站内手册链接（外链 / 锚点 / 图片）→ null。
 * 支持 `/help/<slug>`、相对 `../cues/x`、同组 `x`。
 */
export function resolveManualLink(fromSlug: string, href: string): string | null {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  const [target] = href.split("#");
  if (!target) return null;
  if (target.startsWith("/help/")) return target.slice("/help/".length).replace(/\/$/, "");
  if (target.startsWith("/")) return null;
  const base = fromSlug.split("/").slice(0, -1);
  const parts = [...base];
  for (const seg of target.replace(/\.md$/, "").split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
