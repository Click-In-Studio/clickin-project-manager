import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX } from "@/components/shell/app-shell/toolbar-stage";

const modules = [
  { name: "审批", full: "申请资源权限", short: "申请" },
  { name: "财务", full: "＋ 新建报销", short: "＋" },
  { name: "资产工作台", full: "＋ 上传新 Asset", short: "＋" },
  { name: "成员与部门", full: "＋ 邀请成员", short: "＋" },
] as const;
const acceptanceWidths = [319, 768, 810, 1024, 1280, 1440] as const;

type ModuleCase = typeof modules[number];

declare global {
  interface Window {
    renderProductionModuleToolbar: (moduleCase: ModuleCase) => Promise<void>;
  }
}

let browser: Browser;
let page: Page;
let componentBundle: string;

async function mountToolbar(width: number, moduleCase: ModuleCase) {
  await page.setViewportSize({ width, height: 320 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; width: 100%; overflow-x: hidden; font-family: Arial, sans-serif; }
      button { font: inherit; }
      .topbar { width: 100vw; height: 64px; padding: 0 20px; display: flex; align-items: center; gap: 20px; }
      .brand { width: 102px; flex: none; }
      .project { width: 180px; height: 44px; flex: none; }
      #production-page-toolbar-slot { min-width: 0; flex: 1; height: 100%; }
      [data-production-top-menu-root] { width: 100%; min-width: 0; height: 100%; display: flex; align-items: center; white-space: nowrap; }
      [data-production-top-menu-context] { display: flex; flex: none; align-items: center; }
      [data-production-top-menu-context] > span { height: 28px; padding: 0 8px; display: inline-flex; align-items: center; border: 1px solid #ddd; }
      [data-production-top-menu-divider] { width: 1px; height: 28px; flex: none; background: #ddd; }
      [data-production-top-menu-divider].mx-2 { margin-inline: 8px; }
      [data-production-top-menu-divider].mx-3 { margin-inline: 12px; }
      [data-production-module-top-actions] { margin-left: auto; display: flex; flex: none; align-items: center; gap: 8px; }
      [data-production-module-top-actions] button, .search, .more { height: 32px; padding: 0 12px; display: inline-flex; align-items: center; white-space: nowrap; flex: none; }
      .global { margin-left: -8px; display: flex; flex: none; align-items: center; gap: 12px; }
      .global[class~="ml-0"] { margin-left: 0; }
      .global[class~="-ml-2"] { margin-left: -8px; }
      .topbar[data-stage="1"] .search-label,
      .topbar[data-stage="2"] .search-label,
      .topbar[data-stage="3"] .search-label { display: none; }
      .topbar[data-stage="1"] .search,
      .topbar[data-stage="2"] .search,
      .topbar[data-stage="3"] .search { padding-inline: 10px; }
      #production-page-toolbar-overflow-slot { display: none; }
      @media (max-width: 1023px) {
        .topbar { padding-inline: 10px; gap: 8px; }
        .brand { width: 32px; }
        .project { width: clamp(88px, 28vw, 132px); height: 36px; }
        .global { gap: 6px; }
      }
      @media (max-width: 639px) and (orientation: portrait) {
        .topbar { padding-inline: 6px; gap: 6px; }
        .brand { display: none; }
      }
    </style>
    <div id="root"></div>
    <script>${componentBundle}</script>
  `);

  await page.evaluate(async (currentModule) => {
    await window.renderProductionModuleToolbar(currentModule);
  }, moduleCase);
  return page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-production-top-menu-root]")!;
      const globalActions = document.querySelector<HTMLElement>(".global")!;
      const tail = [...root.children]
        .filter(child => getComputedStyle(child).display !== "none")
        .at(-1) as HTMLElement;
      const action = document.querySelector<HTMLElement>("[data-production-module-top-actions] button");
      const overflowAction = document.querySelector<HTMLElement>("[data-production-module-overflow-actions] button");
      const more = document.querySelector<HTMLElement>(".more");
      const gap = globalActions.getBoundingClientRect().left - tail.getBoundingClientRect().right;
      return {
        stage: Number(root.dataset.productionToolbarStage),
        gap,
        actionText: action?.textContent?.trim() ?? null,
        overflowActionText: overflowAction?.textContent?.trim() ?? null,
        moreVisible: more !== null,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };
    });
}

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import ProductionModuleTopMenu from "@/components/shell/ProductionModuleTopMenu";
        import { ProductionToolbarContext } from "@/components/shell/ProductionTopMenu";
        import { useProductionToolbarStage } from "@/components/shell/app-shell/use-production-toolbar-stage";
        import {
          productionHeaderStageForWidth,
          productionTopbarActionsMarginClass,
        } from "@/components/shell/app-shell/toolbar-stage";

        const root = createRoot(document.getElementById("root"));
        function Harness({ moduleCase }) {
          const toolbar = useProductionToolbarStage({ pathname: "/production/test/approval" });
          const stage = toolbar.productionToolbarStage;
          const headerStage = productionHeaderStageForWidth(window.innerWidth);
          const button = (text, kind) => <button type="button" data-action-kind={kind}>{text}</button>;
          return (
            <ProductionToolbarContext.Provider value={toolbar.productionToolbarContext}>
              <header ref={toolbar.topbarRef} className="topbar" data-stage={stage}>
                <div className="brand">Backstage</div>
                <div className="project">项目</div>
                <div id="production-page-toolbar-slot" />
                <div className={"global " + productionTopbarActionsMarginClass(true, headerStage)}>
                  {stage < 4 && (
                    <button className="search">⌕ {stage < 1 && <span className="search-label">搜索</span>}</button>
                  )}
                  {toolbar.productionToolbarHasStoredControls && <button className="more">更多 ⋮</button>}
                  <div className="overflow-menu">
                    <div id="production-page-toolbar-search-overflow-slot" />
                    <div id="production-page-toolbar-overflow-slot" />
                  </div>
                </div>
              </header>
              <ProductionModuleTopMenu
                label={moduleCase.name}
                primaryAction={button(moduleCase.full, "full")}
                primaryShortAction={button(moduleCase.short, "short")}
                primaryOverflowAction={button(moduleCase.full, "overflow")}
              />
            </ProductionToolbarContext.Provider>
          );
        }

        window.renderProductionModuleToolbar = async (moduleCase) => {
          root.render(<Harness moduleCase={moduleCase} />);
          await new Promise(resolve => {
            let previousSignature = "";
            let stableFrames = 0;
            let frames = 0;
            const check = () => {
              frames += 1;
              const toolbarRoot = document.querySelector("[data-production-top-menu-root]");
              const signature = toolbarRoot?.getAttribute("data-production-toolbar-stage")
                + ":" + document.querySelectorAll(".more").length
                + ":" + document.querySelectorAll("[data-production-module-overflow-actions]").length;
              stableFrames = signature === previousSignature ? stableFrames + 1 : 0;
              previousSignature = signature;
              if (stableFrames >= 4 || frames >= 40) resolve();
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
        };
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  componentBundle = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("制作侧共享顶栏边界", () => {
  for (const moduleCase of modules) {
    for (const width of acceptanceWidths) {
      it(`${moduleCase.name} ${width}px 与搜索 / 更多至少保留 6px，且主操作可达`, async () => {
        const metrics = await mountToolbar(width, moduleCase);
        expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.gap).toBeGreaterThanOrEqual(PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX - 0.5);
        expect(metrics.actionText !== null || (metrics.moreVisible && metrics.overflowActionText !== null)).toBe(true);
        if (width === 319) {
          expect(metrics.actionText === moduleCase.full
            || metrics.actionText === moduleCase.short
            || (metrics.moreVisible && metrics.overflowActionText === moduleCase.full)).toBe(true);
        }
        if (width === 1280 || width === 1440) expect(metrics.actionText).toBe(moduleCase.full);
      });
    }
  }
});
