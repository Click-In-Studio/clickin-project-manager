import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const calendarCss = readFileSync(path.resolve(__dirname, "../../components/ops/planning.module.css"), "utf8");
const phoneWidths = [319, 332, 380, 390, 412, 760];
const hintAcceptanceWidths = [319, 360, 385, 520, 768, 1280];

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

async function mountCalendarHint(width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      body { font-family: Arial, Helvetica, sans-serif; }
      :root { --line: #ccd4d1; --muted: #66736f; --surface: #fff; --ink: #172523; }
      ${calendarCss}
    </style>
    <main style="padding: 24px clamp(18px, 3vw, 52px) 60px; min-height: 100vh;">
      <div class="planningShell">
        <section class="calendarPanel">
          <p class="calendarHint">
            <span class="calendarHintDesktop">桌面端点击日期空白处可快捷新建；移动端点击日期查看当天事项，并使用右下角“＋”新建。绑定事件的任务随事件显示，不单独占格。</span>
            <span class="calendarHintMobile">点日期查看当天事项；点右下角“＋”新建。</span>
          </p>
          <button type="button" class="calendarFloatingCreate">＋</button>
        </section>
      </div>
    </main>
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

  for (const width of hintAcceptanceWidths) {
    it(`${width}px 的日历提示完整显示且不与新建按钮重叠`, async () => {
      await mountCalendarHint(width);
      const metrics = await page.evaluate(() => {
        const mobileHint = document.querySelector<HTMLElement>(".calendarHintMobile")!;
        const desktopHint = document.querySelector<HTMLElement>(".calendarHintDesktop")!;
        const floatingCreate = document.querySelector<HTMLElement>(".calendarFloatingCreate")!;
        const visibleHint = getComputedStyle(mobileHint).display === "none" ? desktopHint : mobileHint;
        const textRange = document.createRange();
        textRange.selectNodeContents(visibleHint);
        const textRects = [...textRange.getClientRects()];
        const buttonRect = floatingCreate.getBoundingClientRect();
        const hintRect = visibleHint.closest(".calendarHint")!.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          text: visibleHint.textContent,
          textLineCount: textRects.length,
          textLeft: textRects[0]?.left ?? hintRect.left,
          textRight: textRects.at(-1)?.right ?? hintRect.right,
          hintLeft: hintRect.left,
          hintRight: hintRect.right,
          buttonDisplay: getComputedStyle(floatingCreate).display,
          buttonLeft: buttonRect.left,
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.textLineCount).toBe(1);
      expect(metrics.textLeft).toBeGreaterThanOrEqual(metrics.hintLeft);
      expect(metrics.textRight).toBeLessThanOrEqual(metrics.hintRight);
      if (width <= 760) {
        expect(metrics.text).toBe("点日期查看当天事项；点右下角“＋”新建。");
        expect(metrics.buttonDisplay).not.toBe("none");
        expect(metrics.textRight).toBeLessThan(metrics.buttonLeft);
      } else {
        expect(metrics.buttonDisplay).toBe("none");
      }
    });
  }
});
