import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadManual, manualRouteIndex, resolveManualLink, extractBodyRefs, MANUAL_ROOT } from "@/lib/help/manual";
import { CREATION_NAV, PRODUCTION_NAV, ADMIN_NAV_GROUPS, OVERVIEW_NAV } from "@/components/shell/app-shell/nav-config";

/**
 * 使用手册覆盖棘轮（#531 / #523）：保证「一个功能一个 md」不烂尾。
 *
 * ① 产品内导航（nav-config 三组 + 我的面）的每个入口都要能映射到一篇手册页
 *    （frontmatter `routes`），不留临时缺页白名单。
 * ② 仓库真实内容能被加载（frontmatter 齐、取值合法）、按模板写（四个固定小节）、
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
  "/my/projects", "/my/daily-call", "/my/notification-settings",
  "characters", "cuelists", "notifications", "announcements", "access-requests", "import-script", "import-scenes",
  "script/print", "wiki/print", "events/callsheet", "events/reqs", "events/reports", "events/view",
  "assets/upload", "assets/preview", "dramaturgy/inspiration",
]);

/** `_TEMPLATE.md` 的四个固定小节；内容 issue 的验收标准之一是「按模板写」。 */
const TEMPLATE_SECTIONS = ["这是什么", "怎么操作", "注意事项", "常见问题"];

const manual = loadManual();
const routeIndex = manualRouteIndex(manual);
const slugs = new Set(manual.pages.map((p) => p.slug));

describe("手册覆盖棘轮：导航入口 ↔ 手册页", () => {
  it("nav-config 的每个入口都有手册页", () => {
    const uncovered = navRoutes().filter((r) => !routeIndex.has(r));
    expect(uncovered, "导航新增了功能却没有手册页：请在同一 PR 里向 content/manual 补页，并在 frontmatter routes 写上该 path").toEqual([]);
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
