import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadManual, manualRouteIndex, resolveManualLink, extractBodyRefs, MANUAL_ROOT } from "@/lib/help/manual";
import { CREATION_NAV, PRODUCTION_NAV, ADMIN_NAV_GROUPS, OVERVIEW_NAV } from "@/components/shell/app-shell/nav-config";

/**
 * 使用手册覆盖棘轮（#531 / #523）：保证「一个功能一个 md」不烂尾。
 *
 * ① 产品内导航（nav-config 三组 + 我的面）的每个入口都要能映射到一篇手册页
 *    （frontmatter `routes`）。壳子阶段允许缺页，但缺的必须列在 MISSING_ALLOWED
 *    里；内容 issue（#532–#537）每合一批就从名单里划掉对应条目。
 * ② 名单不许有幽灵条目：一旦某路由有了手册页，还留在名单里就红——逼着名单只减不增。
 * ③ 仓库真实内容能被加载（frontmatter 齐、取值合法）、按模板写（四个固定小节）、
 *    互链 / related / 首页配置指向存在的页、图片存在于 public/。
 */

const ROOT = process.cwd();

/** nav-config 口径的产品内路由：项目页 path 原样、管理面板 admin/<path>、我的面 /my/... */
function navRoutes(): string[] {
  return [
    ...CREATION_NAV.map((i) => i.path),
    ...PRODUCTION_NAV.map((i) => i.path),
    ...ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => (i.path ? `admin/${i.path}` : "admin"))),
    ...OVERVIEW_NAV.map((i) => i.path),
  ];
}

/** 不在侧栏里、但手册页可以声明的路由（防 routes 里出现拼写错误的野路由）。 */
const EXTRA_ROUTES = new Set([
  "/", "/login", "/invite", "/share", "/unauthorized",
  "/account", "/account/profile", "/account/security", "/account/preferences",
  "/my/projects", "/my/permissions", "/my/daily-call", "/my/notification-settings",
  "characters", "cuelists", "notifications", "access-requests", "import-script", "import-scenes",
  "script/print", "wiki/print", "events/callsheet", "events/reqs", "events/reports", "events/view",
  "assets/upload", "assets/preview", "dramaturgy/inspiration",
]);

/**
 * 壳子阶段的缺页名单。内容 issue 合并时把对应行删掉；名单清空后由 #538 删掉整个机制。
 * 只减不增：往这里加条目 = 侧栏新增了功能却没写手册，请同 PR 补页。
 */
const MISSING_ALLOWED = new Set<string>([
  // #534 制作（前半）
  "contacts", "planning", "events", "tasks", "reports",
  // #535 制作（后半）
  "wiki", "finance", "materials", "assets",
  // #536 管理项目
  // （admin/templates 已由 #533 Cue 表设置覆盖、admin/migration 已由 #533 导入篇覆盖）
  "admin", "admin/milestones", "admin/announcements", "admin/organization", "admin/roles",
  "admin/permissions", "admin/policies", "admin/audit", "admin/asset-review",
  "admin/settings", "admin/producer", "admin/danger",
  // #537 个人与账号（/my/notifications 已由 #532 通知篇覆盖）
  "/my/announcements", "/my/weekly-call", "/my/tasks", "/my/reports",
]);

/** `_TEMPLATE.md` 的四个固定小节；内容 issue 的验收标准之一是「按模板写」。 */
const TEMPLATE_SECTIONS = ["这是什么", "怎么操作", "注意事项", "常见问题"];

const manual = loadManual();
const routeIndex = manualRouteIndex(manual);
const slugs = new Set(manual.pages.map((p) => p.slug));

describe("手册覆盖棘轮：导航入口 ↔ 手册页", () => {
  it("nav-config 的每个入口都有手册页，或列在 MISSING_ALLOWED 里", () => {
    const uncovered = navRoutes().filter((r) => !routeIndex.has(r) && !MISSING_ALLOWED.has(r));
    expect(uncovered, "侧栏新增了功能却没有手册页：请在 content/manual 补页（frontmatter routes 写上该 path），或先把它列进 MISSING_ALLOWED 并开内容 issue").toEqual([]);
  });

  it("MISSING_ALLOWED 没有幽灵条目：已有手册页的路由必须从名单划掉", () => {
    const ghosts = [...MISSING_ALLOWED].filter((r) => routeIndex.has(r));
    expect(ghosts, "这些路由已有手册页，请从 MISSING_ALLOWED 删除").toEqual([]);
  });

  it("MISSING_ALLOWED 只含真实存在的导航入口（防止名单里留着已下线功能）", () => {
    const nav = new Set(navRoutes());
    const stale = [...MISSING_ALLOWED].filter((r) => !nav.has(r));
    expect(stale).toEqual([]);
  });

  it("frontmatter routes 只写已知路由（导航口径或 EXTRA_ROUTES），防拼写错误", () => {
    const known = new Set([...navRoutes(), ...EXTRA_ROUTES]);
    const bad = manual.pages.flatMap((p) => p.routes.filter((r) => !known.has(r)).map((r) => `${p.slug}: ${r}`));
    expect(bad, "routes 里出现未知路由；若是新页面请先加进 EXTRA_ROUTES").toEqual([]);
  });
});

describe("手册内容自洽", () => {
  it("至少有一篇文章，且每个一级分类目录都在（IA 六段）", () => {
    expect(manual.pages.length).toBeGreaterThan(0);
    expect(manual.sections.map((s) => s.slug)).toEqual(["start", "creation", "production", "admin", "account", "ai"]);
  });

  it("每篇按模板写：四个固定小节齐全", () => {
    const missing = manual.pages.flatMap((p) => {
      const h2 = new Set(p.headings.filter((h) => h.depth === 2).map((h) => h.text));
      return TEMPLATE_SECTIONS.filter((s) => !h2.has(s)).map((s) => `${p.slug} 缺「${s}」`);
    });
    expect(missing, "请按 content/manual/_TEMPLATE.md 的四节写").toEqual([]);
  });

  it("每篇有 summary 与 updated（首页卡片 / 列表 / 更新时间都靠它们）", () => {
    const bad = manual.pages.filter((p) => !p.summary || !p.updated).map((p) => p.slug);
    expect(bad).toEqual([]);
  });

  it("related 与 _home.md 指向存在的页", () => {
    const badRelated = manual.pages.flatMap((p) => p.related.filter((s) => !slugs.has(s)).map((s) => `${p.slug} → ${s}`));
    const badHome = [...manual.home.quickstart, ...manual.home.popular].filter((s) => !slugs.has(s));
    expect(badRelated).toEqual([]);
    expect(badHome).toEqual([]);
  });

  it("正文站内互链解析到存在的页；图片存在于 public/", () => {
    const badLinks: string[] = [];
    const badImages: string[] = [];
    for (const p of manual.pages) {
      const { links, images } = extractBodyRefs(p.body);
      for (const href of links) {
        const target = resolveManualLink(p.slug, href);
        if (target && !slugs.has(target)) badLinks.push(`${p.slug}: ${href}`);
      }
      for (const src of images) {
        if (!src.startsWith("/manual/")) { badImages.push(`${p.slug}: ${src}（图片请放 public/manual/）`); continue; }
        if (!existsSync(path.join(ROOT, "public", src))) badImages.push(`${p.slug}: ${src} 不存在`);
      }
    }
    expect(badLinks).toEqual([]);
    expect(badImages).toEqual([]);
  });

  it("模板与首页配置文件在位（作者入口）", () => {
    expect(existsSync(path.join(MANUAL_ROOT, "_TEMPLATE.md"))).toBe(true);
    expect(existsSync(path.join(MANUAL_ROOT, "_home.md"))).toBe(true);
  });
});
