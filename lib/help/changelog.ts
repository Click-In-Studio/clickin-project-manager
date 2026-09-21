// 更新日志（#569）内容源：`content/changelog/` 下的 markdown，服务端 fs 直读，
// 与使用手册（lib/help/manual.ts）同一套 frontmatter 子集、同一套写法规则。
//
// 为什么不是 commit message 拼接：读者是导演 / 舞监，`chore(db): #486 项目本体搬出
// db.ts` 对他们是噪音，`fix(collab): #578 在场心跳` 得翻译成「安静读剧本的人不再从
// 在场头像里消失」才有意义。翻译没法机械做，所以日志是**人写的一份独立内容**——
// 功能 PR 改手册页的同时顺手写一条（DEV_GUIDE §12.8），发版时卷成一个版本。
//
// 目录：
//   content/changelog/_TEMPLATE.md          作者模板，不是条目
//   content/changelog/unreleased/<pr>-<x>.md 已合并、还没随 tag 发到 prod 的条目（每 PR 一个文件，避免冲突）
//   content/changelog/v0.1.2/_index.md      一个版本：date（必填）/ summary
//   content/changelog/v0.1.2/<pr>-<x>.md    该版本的条目（发版脚本从 unreleased/ 搬进来）
// 版本目录名 = git tag 名；deploy 在 tag 发布时校验 content/changelog/<tag>/_index.md 存在。
// 下划线开头的文件不是条目。standalone 构建靠 next.config.ts 的 outputFileTracingIncludes 圈进来。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, FrontmatterError, type Frontmatter } from "./frontmatter";

export const CHANGELOG_ROOT = path.join(process.cwd(), "content", "changelog");
export const CHANGELOG_UNRELEASED_DIR = "unreleased";

/** 飞书「新增 / 优化 / 修复」+ 下线；渲染顺序即此顺序。 */
export const CHANGELOG_KINDS = ["new", "improved", "fixed", "removed"] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];
export const CHANGELOG_KIND_LABELS: Record<ChangelogKind, string> = { new: "新增", improved: "优化", fixed: "修复", removed: "下线" };

/**
 * 版本目录名 = tag 名，形态见 DEV_GUIDE §4「版本号」（#612）：
 *   v<M>.<m>.<p>                里程碑（阶段 / 正式版 / 功能落地），无日期段
 *   v<M>.<m>.<p>-yymmdd         日常发版（周三、周日会后），日期段 = 上一个里程碑之后的第几天
 *   <上面任一>-hot<n>           hotfix：沿用被修版本的完整号 + 序号
 * 三段固定，`v0.2` 这种两段号不再接受。
 */
export const CHANGELOG_VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d{6}))?(?:-hot([1-9]\d*))?$/;

export type ParsedVersion = { major: number; minor: number; patch: number; date: number; hot: number };

/** 拆 tag 名；不合形态返回 null。缺日期段 / 缺 hot 段记 0，排序时自然排在同里程碑的日常版 / hotfix 之前。 */
export function parseVersion(tag: string): ParsedVersion | null {
  const m = CHANGELOG_VERSION_RE.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), date: m[4] ? Number(m[4]) : 0, hot: m[5] ? Number(m[5]) : 0 };
}

export type ChangelogEntry = {
  /** 文件名去 .md；同一版本内唯一 */
  id: string;
  file: string;
  kind: ChangelogKind;
  /** 一句话，用户语言（必填）。列表里加粗显示 */
  title: string;
  /** 对应手册页 slug → 「了解更多」；测试校验存在 */
  page: string | null;
  /** 来源 PR 号；只进 title 属性，不给读者看 */
  pr: number | null;
  order: number;
  /** 可选展开说明（markdown），可放截图 */
  body: string;
};

export type ChangelogVersion = {
  /** 目录名 = tag：v0.1.2 / v0.1.2-260921 */
  version: string;
  dir: string;
  /** YYYY-MM-DD，`_index.md` 必填 */
  date: string;
  summary: string | null;
  entries: ChangelogEntry[];
};

export type Changelog = {
  /** 新版在前 */
  versions: ChangelogVersion[];
  /** 已合并未发版的条目（dev 环境渲染成「即将发布」；prod 上发版已卷走，为空） */
  unreleased: ChangelogEntry[];
};

export class ChangelogContentError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

let cached: Changelog | null = null;

/** 缓存语义与 loadManual 一致：生产进程内一次，开发每次重读，测试传 root 绕过。任一条出错整体抛。 */
export function loadChangelog(root: string = CHANGELOG_ROOT): Changelog {
  if (root === CHANGELOG_ROOT && process.env.NODE_ENV === "production" && cached) return cached;
  const log = readChangelogTree(root);
  if (root === CHANGELOG_ROOT) cached = log;
  return log;
}

/** 最新已发版本号；红点用它做「看过没有」的键。没有版本目录时为 null。 */
export function latestChangelogVersion(log: Changelog): string | null {
  return log.versions[0]?.version ?? null;
}

/** 手册页 → 最近一次提到它的版本（「本页功能有更新」标记，#569 B3）。 */
export function changelogForPage(log: Changelog, slug: string): { version: ChangelogVersion; entries: ChangelogEntry[] } | null {
  for (const version of log.versions) {
    const entries = version.entries.filter((e) => e.page === slug);
    if (entries.length) return { version, entries };
  }
  return null;
}

/** 2026-09-20 → 「2026 年 9 月 20 日」：版本标题与手册页顶部的更新条共用。 */
export function formatChangelogDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return `${y} 年 ${m} 月 ${day} 日`;
}

/** 按 kind 分组（保持 CHANGELOG_KINDS 顺序，空组不出现）。 */
export function groupByKind(entries: ChangelogEntry[]): { kind: ChangelogKind; label: string; entries: ChangelogEntry[] }[] {
  return CHANGELOG_KINDS
    .map((kind) => ({ kind, label: CHANGELOG_KIND_LABELS[kind], entries: entries.filter((e) => e.kind === kind) }))
    .filter((g) => g.entries.length > 0);
}

/**
 * 版本号比较，返回正数表示 a 更新。顺序：里程碑三段 → 日期 → hot 序号，
 * 即 v0.1.1 < v0.1.1-260921 < v0.1.1-260921-hot1 < v0.1.1-260924 < v0.1.2 < v0.2.0。
 * 注意日期版在同号里程碑**之后**，与 semver 预发布语义相反——日常版是里程碑的后续，不是它的预览。
 * 不合形态的号按 0 处理（调用前目录名已过正则校验，这里只是兜底不抛）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? { major: 0, minor: 0, patch: 0, date: 0, hot: 0 };
  const pb = parseVersion(b) ?? { major: 0, minor: 0, patch: 0, date: 0, hot: 0 };
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch || pa.date - pb.date || pa.hot - pb.hot;
}

function readChangelogTree(root: string): Changelog {
  if (!existsSync(root)) throw new ChangelogContentError(root, "更新日志目录不存在");
  const versions: ChangelogVersion[] = [];
  let unreleased: ChangelogEntry[] = [];
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (name.startsWith("_") || name.startsWith(".") || !statSync(dir).isDirectory()) continue;
    if (name === CHANGELOG_UNRELEASED_DIR) {
      unreleased = readEntries(dir);
      continue;
    }
    if (!CHANGELOG_VERSION_RE.test(name)) {
      throw new ChangelogContentError(dir, `版本目录名必须是 tag 形态（v0.1.0 / v0.1.0-260921 / v0.1.0-260921-hot1），收到 ${name}`);
    }
    const indexFile = path.join(dir, "_index.md");
    if (!existsSync(indexFile)) throw new ChangelogContentError(indexFile, "版本目录缺少 _index.md（date 必填）");
    const { data } = readFrontmatter(indexFile);
    const date = requireString(indexFile, data, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ChangelogContentError(indexFile, `date 要写 YYYY-MM-DD，收到 ${date}`);
    versions.push({ version: name, dir, date, summary: optionalString(indexFile, data, "summary"), entries: readEntries(dir) });
  }
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return { versions, unreleased };
}

function readEntries(dir: string): ChangelogEntry[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => readEntry(path.join(dir, f)))
    .sort((a, b) => CHANGELOG_KINDS.indexOf(a.kind) - CHANGELOG_KINDS.indexOf(b.kind) || a.order - b.order || a.id.localeCompare(b.id));
}

function readEntry(file: string): ChangelogEntry {
  const { data, body } = readFrontmatter(file);
  const kind = requireString(file, data, "kind");
  if (!(CHANGELOG_KINDS as readonly string[]).includes(kind)) {
    throw new ChangelogContentError(file, `kind 只能是 ${CHANGELOG_KINDS.join(" / ")}，收到 ${kind}`);
  }
  const pr = data.pr;
  if (pr !== undefined && (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0)) {
    throw new ChangelogContentError(file, "pr 要写正整数");
  }
  const page = optionalString(file, data, "page");
  if (page && (page.startsWith("/") || page.endsWith(".md"))) {
    throw new ChangelogContentError(file, `page 写手册页 slug（creation/script/editing），收到 ${page}`);
  }
  return {
    id: path.basename(file, ".md"),
    file,
    kind: kind as ChangelogKind,
    title: requireString(file, data, "title"),
    page,
    pr: typeof pr === "number" ? pr : null,
    order: optionalNumber(file, data, "order") ?? 0,
    body: body.trim(),
  };
}

function readFrontmatter(file: string): { data: Frontmatter; body: string } {
  try {
    return parseFrontmatter(readFileSync(file, "utf8"));
  } catch (e) {
    if (e instanceof FrontmatterError) throw new ChangelogContentError(file, e.message);
    throw e;
  }
}

function requireString(file: string, data: Frontmatter, key: string): string {
  const v = data[key];
  if (typeof v !== "string" || !v.trim()) throw new ChangelogContentError(file, `frontmatter 缺少 ${key}`);
  return v.trim();
}
function optionalString(file: string, data: Frontmatter, key: string): string | null {
  const v = data[key];
  if (v === undefined) return null;
  if (typeof v !== "string") throw new ChangelogContentError(file, `${key} 要是字符串`);
  return v.trim() || null;
}
function optionalNumber(file: string, data: Frontmatter, key: string): number | null {
  const v = data[key];
  if (v === undefined) return null;
  if (typeof v !== "number") throw new ChangelogContentError(file, `${key} 要是数字`);
  return v;
}
