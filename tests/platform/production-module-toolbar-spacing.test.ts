import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX } from "@/components/shell/app-shell/toolbar-stage";

const menuSource = readFileSync("components/shell/ProductionModuleTopMenu.tsx", "utf8");
const shellSource = readFileSync("components/shell/AppShell.tsx", "utf8");
const dividerSource = readFileSync("components/shell/ProductionTopMenu.tsx", "utf8");

const modules = [
  { name: "审批", full: "申请资源权限", short: "申请" },
  { name: "财务", full: "＋ 新建报销", short: "＋" },
  { name: "资产工作台", full: "＋ 上传新 Asset", short: "＋" },
] as const;
const acceptanceWidths = [319, 385, 645, 1440] as const;

let browser: Browser;
let page: Page;

async function mountToolbar(width: number, moduleCase: typeof modules[number]) {
  await page.setViewportSize({ width, height: 320 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; overflow-x: hidden; font-family: Arial, sans-serif; }
      .topbar { width: 100vw; height: 64px; padding: 0 20px; display: flex; align-items: center; gap: 20px; }
      .brand { width: 102px; flex: none; }
      .project { width: 180px; height: 44px; flex: none; }
      .slot { min-width: 0; flex: 1; }
      .root { width: 100%; min-width: 0; display: flex; align-items: center; white-space: nowrap; }
      .badge { height: 28px; padding: 0 8px; display: inline-flex; align-items: center; flex: none; border: 1px solid #ddd; }
      .divider { width: 1px; height: 28px; margin: 0 12px; flex: none; background: #ddd; }
      .actions { margin-left: auto; display: flex; flex: none; }
      .action, .search, .more { height: 32px; padding: 0 12px; white-space: nowrap; flex: none; }
      .global { margin-left: -8px; display: flex; flex: none; align-items: center; gap: 12px; }
      .short, .more { display: none; }
      .topbar[data-stage="1"] .search-label { display: none; }
      .topbar[data-stage="1"] .search { padding-inline: 10px; }
      .topbar[data-stage="2"] .search-label,
      .topbar[data-stage="3"] .search-label { display: none; }
      .topbar[data-stage="2"] .search,
      .topbar[data-stage="3"] .search { padding-inline: 10px; }
      .root[data-stage="3"] .full { display: none; }
      .root[data-stage="3"] .short { display: inline-flex; }
      .root[data-stage="3"] .divider { margin-inline: 8px; }
      .root[data-stage="4"] .actions, .root[data-stage="4"] .divider { display: none; }
      .topbar[data-stage="4"] .search { display: none; }
      .topbar[data-stage="4"] .more { display: inline-flex; }
      @media (max-width: 1023px) {
        .topbar { padding-inline: 10px; gap: 8px; }
        .brand { width: 32px; }
        .project { width: clamp(88px, 28vw, 132px); height: 36px; }
        .global { margin-left: 0; gap: 6px; }
      }
      @media (max-width: 639px) and (orientation: portrait) {
        .topbar { padding-inline: 6px; gap: 6px; }
        .brand { display: none; }
      }
    </style>
    <header class="topbar">
      <div class="brand">Backstage</div><div class="project">项目</div>
      <div class="slot">
        <div class="root" data-stage="0">
          <span class="badge">${moduleCase.name}</span><span class="divider"></span>
          <div class="actions"><button class="action full">${moduleCase.full}</button><button class="action short">${moduleCase.short}</button></div>
        </div>
      </div>
      <div class="global"><button class="search">⌕ <span class="search-label">搜索</span></button><button class="more">更多 ⋮</button></div>
    </header>
    <div class="overflow-menu" hidden><button>${moduleCase.full.replace(/^＋\s*/, "")}</button></div>
  `);

  const metrics = await page.evaluate((minimumGap) => {
    const root = document.querySelector<HTMLElement>(".root")!;
    const topbar = document.querySelector<HTMLElement>(".topbar")!;
    const globalActions = document.querySelector<HTMLElement>(".global")!;
    let stage = 0;
    for (; stage <= 4; stage += 1) {
      root.dataset.stage = String(stage);
      topbar.dataset.stage = String(stage);
      const tail = [...root.children].filter(child => getComputedStyle(child).display !== "none").at(-1) as HTMLElement;
      const gap = globalActions.getBoundingClientRect().left - tail.getBoundingClientRect().right;
      const overflow = topbar.scrollWidth - topbar.clientWidth;
      if (gap >= minimumGap - 0.5 && overflow <= 1) break;
    }
    const tail = [...root.children].filter(child => getComputedStyle(child).display !== "none").at(-1) as HTMLElement;
    const action = [...document.querySelectorAll<HTMLElement>(".action")]
      .find(item => getComputedStyle(item).display !== "none");
    const more = document.querySelector<HTMLElement>(".more")!;
    return {
      stage,
      gap: globalActions.getBoundingClientRect().left - tail.getBoundingClientRect().right,
      actionText: action?.textContent?.trim() ?? null,
      moreVisible: getComputedStyle(more).display !== "none",
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  }, PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX);
  return metrics;
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("制作侧共享顶栏边界", () => {
  it("共享层收紧 divider，并只在紧凑壳取消负外边距", () => {
    expect(dividerSource).toContain('compact ? "mx-2" : "mx-3"');
    expect(shellSource).toContain('productionHeaderStage >= 2 ? "ml-0" : "-ml-2"');
    expect(menuSource).toContain("primaryShortAction");
    expect(menuSource).toContain("primaryOverflowAction");
  });

  for (const moduleCase of modules) {
    for (const width of acceptanceWidths) {
      it(`${moduleCase.name} ${width}px 与搜索 / 更多至少保留 6px，且主操作可达`, async () => {
        const metrics = await mountToolbar(width, moduleCase);
        expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.gap).toBeGreaterThanOrEqual(PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX - 0.5);
        expect(metrics.actionText !== null || metrics.moreVisible).toBe(true);
        if (width === 319) expect([moduleCase.full, moduleCase.short]).toContain(metrics.actionText);
        if (width === 645 || width === 1440) expect(metrics.actionText).toContain(moduleCase.full);
      });
    }
  }
});
