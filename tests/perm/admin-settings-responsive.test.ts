import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import AdminSettingsClient, { type SettingsPerms } from "@/components/admin/AdminSettingsClient";

const css = readFileSync("components/admin/admin-settings.module.css", "utf8");
const acceptanceWidths = [319, 375, 453, 768, 1280] as const;
const allPerms: SettingsPerms = {
  canRename: true,
  canChangeAvatar: true,
  canEditDescription: true,
  canChangeType: true,
  canChangeLanguage: true,
  canArchive: true,
  canDelete: true,
  canImportScript: true,
  canImportScenes: true,
  canManageTags: true,
  canToggleWatermark: true,
  canEditAiInstructions: true,
  canSeeAiUsage: true,
  canSeeAiUsageMembers: true,
};

let browser: Browser;
let page: Page;

function renderSettings(perms: SettingsPerms = allPerms) {
  const markup = renderToStaticMarkup(createElement(AdminSettingsClient, {
    productionId: "test-production",
    initialMeta: {
      name: "一个很长的项目名称用于检查窄屏布局",
      description: "项目简介",
      avatarUrl: null,
      type: "other",
      typeLabel: "自定义类型名称",
      language: "普通话",
      watermarkEnabled: false,
    },
    isArchived: false,
    perms,
  }));
  // 浏览器验收直接加载源码 CSS；将 Vite 生成的 `_local_hash` 类名还原为源码类名。
  return markup.replace(/\b_([A-Za-z][A-Za-z0-9]*)_[a-z0-9]+\b/g, "$1");
}

async function mountBasicInfo(width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --paper: #f6f5f1;
        --surface: #f2f3f2;
        --line: #d7dcda;
        --ink: #172523;
        --muted: #66736f;
      }
      ${css}
    </style>
    ${renderSettings()}
  `);
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("项目信息基本资料响应式布局", () => {
  it("真实组件只给五个基本信息行挂移动布局，权限不足时仍显示原锁定提示", async () => {
    await mountBasicInfo(375);
    await expect.poll(() => page.locator(".basicInfoRow").count()).toBe(5);
    expect(await page.locator(".settingRow:not(.basicInfoRow)").count()).toBeGreaterThan(0);

    const lockedMarkup = renderSettings(Object.fromEntries(
      Object.keys(allPerms).map((key) => [key, false]),
    ) as SettingsPerms);
    expect(lockedMarkup).toContain("需要 production:rename 权限");
    expect(lockedMarkup).toContain("需要 production:change_avatar 权限");
    expect(lockedMarkup).toContain("需要 production:edit_description 权限");
    expect(lockedMarkup).toContain("需要 production:change_type 权限");
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下控件完整留在基本信息卡内`, async () => {
      await mountBasicInfo(width);
      const metrics = await page.locator(".basicInfoCard").evaluate((card, viewportWidth) => {
        const rows = [...card.querySelectorAll<HTMLElement>(".basicInfoRow")];
        const controls = [...card.querySelectorAll<HTMLElement>("input, textarea, button")];
        const firstRowStyle = getComputedStyle(rows[0]);
        const controlBounds = controls.map((control) => {
          const bounds = control.getBoundingClientRect();
          const rowBounds = control.closest<HTMLElement>(".basicInfoRow")!.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            rowLeft: rowBounds.left,
            rowRight: rowBounds.right,
            fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
            visible: bounds.width > 0 && bounds.height > 0,
          };
        }).filter((control) => control.visible);
        return {
          viewportWidth,
          documentWidth: document.documentElement.scrollWidth,
          rowDisplay: firstRowStyle.display,
          rowColumns: firstRowStyle.gridTemplateColumns,
          controlBounds,
        };
      }, width);

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.rowDisplay).toBe(width <= 600 ? "block" : "grid");
      if (width > 600) expect(metrics.rowColumns).toMatch(/^220px /);
      for (const control of metrics.controlBounds) {
        expect(control.left).toBeGreaterThanOrEqual(control.rowLeft - 0.5);
        expect(control.right).toBeLessThanOrEqual(control.rowRight + 0.5);
        if (width <= 600) expect(control.fontSize).toBeGreaterThanOrEqual(16);
      }
    });
  }

  for (const width of [319, 375, 453] as const) {
    it(`${width}px 下名称、简介和类型的保存按钮占满可用宽度`, async () => {
      await mountBasicInfo(width);
      const widths = await page.locator(".basicInfoRow").evaluateAll((rows) => rows
        .filter((_, index) => index !== 1)
        .map((row) => {
          const content = row.querySelector<HTMLElement>(".rowContent")!.getBoundingClientRect();
          const button = row.querySelector<HTMLButtonElement>(".basicInfoButton")!.getBoundingClientRect();
          return { content: content.width, button: button.width };
        }));
      for (const measured of widths) expect(measured.button).toBeCloseTo(measured.content, 0);
    });
  }
});
