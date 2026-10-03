import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import styles from "@/components/admin/admin-danger.module.css";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import AdminDangerSection from "@/components/admin/AdminDangerSection";
import TransferOwnerCard from "@/components/admin/TransferOwnerCard";

const localClassNames = [
  "page", "mobileBack", "dangerCard", "transferCard", "dangerHeader",
  "dangerRow", "dangerLabel", "dangerControl", "deleteConfirmRow",
  "transferControls", "ownerPicker", "ownerConfirmInput", "ownerConfirmButton",
] as const;
const classNames = Object.fromEntries(
  localClassNames.map(name => [name, styles[name]]),
) as Record<(typeof localClassNames)[number], string>;
const css = readFileSync("components/admin/admin-danger.module.css", "utf8");
const browserCss = Object.entries(classNames).reduce(
  (source, [localName, generatedName]) => source.replaceAll(`.${localName}`, `.${generatedName}`),
  css.replace(/:global\(([^)]+)\)/g, "$1"),
);
const dangerPage = readFileSync("app/production/[id]/admin/danger/page.tsx", "utf8");

const dangerMarkup = renderToStaticMarkup(createElement(Fragment, null,
  createElement(TransferOwnerCard, {
    productionId: "prod_1",
    currentOwnerName: "当前 Owner",
    members: [],
    depts: [],
    ownerId: "owner_1",
  }),
  createElement(AdminDangerSection, {
    productionId: "prod_1",
    productionName: "测试项目",
    isArchived: false,
    canArchive: true,
    canDelete: true,
  }),
));

let browser: Browser;
let page: Page;

async function mountDangerPage(width: number) {
  await page.setViewportSize({ width, height: 727 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --paper: #f6f5f1;
        --surface: #fff;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
        --danger: #a83232;
      }
      ${browserCss}
    </style>
    <div class="app-shell-frame">
      <main>
        <div class="${styles.page}">
          <a class="${styles.mobileBack}" href="#project">← 返回项目</a>
          ${dangerMarkup}
        </div>
      </main>
      <nav class="app-shell-bottom-nav"><a href="#project">返回</a><button>配置菜单</button><button>我</button></nav>
    </div>
  `);
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("危险操作页响应式布局", () => {
  it("页面返回入口使用路由范围样式钩子，不修改全局 AppShell", () => {
    expect(dangerPage).toContain("className={styles.page}");
    expect(dangerPage).toContain("className={styles.mobileBack}");
  });

  for (const width of [319, 375, 768, 1280]) {
    it(`${width}px 下内容不横向溢出且返回入口落在正确位置`, async () => {
      await mountDangerPage(width);
      const metrics = await page.locator(`.${styles.page}`).evaluate((root, names) => {
        const row = root.querySelector<HTMLElement>(`.${names.dangerRow}`)!;
        const deleteRow = root.querySelector<HTMLElement>(`.${names.deleteConfirmRow}`)!;
        const transfer = root.querySelector<HTMLElement>(`.${names.transferControls}`)!;
        const back = root.querySelector<HTMLElement>(`.${names.mobileBack}`)!;
        return {
          columns: getComputedStyle(row).gridTemplateColumns.split(" ").length,
          deleteDirection: getComputedStyle(deleteRow).flexDirection,
          transferDisplay: getComputedStyle(transfer).display,
          backDisplay: getComputedStyle(back).display,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      }, classNames);
      const bottomBackVisible = await page.locator(".app-shell-bottom-nav > a").isVisible();

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.columns).toBe(width <= 639 ? 1 : 2);
      expect(metrics.deleteDirection).toBe(width <= 639 ? "column" : "row");
      expect(metrics.transferDisplay).toBe(width <= 639 ? "grid" : "flex");
      expect(metrics.backDisplay).toBe(width <= 1023 ? "inline-flex" : "none");
      expect(bottomBackVisible).toBe(width > 1023);
    });
  }
});
