import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const calendarCss = readFileSync(path.resolve(__dirname, "../../components/ops/planning.module.css"), "utf8");
const phoneWidths = [319, 332, 380, 390, 412, 760];

let browser: Browser;
let page: Page;

async function mountDenseCell(width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      :root { --line: #ccd4d1; --muted: #66736f; --surface: #fff; --ink: #172523; }
      ${calendarCss}
    </style>
    <div class="calendarCell" data-calendar-date="2031-04-12">
      <button class="calendarDateButton">12</button>
      <button class="calendarChip calendarPhaseChip"><span class="calendarChipTitle">▸ 3 个阶段</span></button>
      <button class="calendarChip"><span class="calendarChipTitle">合成排练</span></button>
      <button class="calendarChip calendarMobileHidden"><span class="calendarChipTitle">灯光联排</span></button>
      <button class="calendarHiddenDesktop">+2 项</button>
      <button class="calendarHiddenMobile">+3 项</button>
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

describe("项目日历真实浏览器布局", () => {
  for (const width of phoneWidths) {
    it(`${width}px 的密集日期内容不越出格子`, async () => {
      await mountDenseCell(width);
      const metrics = await page.locator(".calendarCell").evaluate(cell => {
        const bounds = cell.getBoundingClientRect();
        const visibleChildren = [...cell.children].filter(child => getComputedStyle(child).display !== "none");
        return {
          clientHeight: cell.clientHeight,
          scrollHeight: cell.scrollHeight,
          childBounds: visibleChildren.map(child => {
            const rect = child.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
          bounds: { top: bounds.top, bottom: bounds.bottom },
        };
      });

      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
      expect(metrics.childBounds).toHaveLength(4);
      for (const child of metrics.childBounds) {
        expect(child.top).toBeGreaterThanOrEqual(metrics.bounds.top);
        expect(child.bottom).toBeLessThanOrEqual(metrics.bounds.bottom);
      }
    });
  }

  it("桌面密集日期仍保留三条事项和桌面摘要", async () => {
    await mountDenseCell(1280);
    const metrics = await page.locator(".calendarCell").evaluate(cell => ({
      clientHeight: cell.clientHeight,
      scrollHeight: cell.scrollHeight,
      visibleTexts: [...cell.children]
        .filter(child => getComputedStyle(child).display !== "none")
        .map(child => child.textContent?.trim()),
    }));

    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
    expect(metrics.visibleTexts).toEqual(["12", "▸ 3 个阶段", "合成排练", "灯光联排", "+2 项"]);
  });
});
