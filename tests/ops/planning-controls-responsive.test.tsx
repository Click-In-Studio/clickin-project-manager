import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const planningClient = readFileSync("components/ops/PlanningClient.tsx", "utf8");
const ganttView = readFileSync("components/ops/planning/TaskGanttView.tsx", "utf8");
const css = readFileSync("components/ops/planning.module.css", "utf8");
const acceptanceWidths = [319, 360, 571, 1118];

let browser: Browser;
let page: Page;

async function mountGanttScale(width: number) {
  await page.setViewportSize({ width, height: 480 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root { --line: #ccd4d1; --muted: #66736f; --surface: #fff; --ink: #172523; }
      ${css}
    </style>
    <div class="ganttControls">
      <div class="ganttScale" aria-label="时间轴粒度">
        <button class="ganttScaleButton" aria-pressed="false">日</button>
        <button class="ganttScaleButton" aria-pressed="true">月</button>
        <button class="ganttScaleButton" aria-pressed="false">季</button>
        <button class="ganttScaleButton" aria-pressed="false">年</button>
      </div>
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

describe("计划页移动端控制区", () => {
  it("主视图页签保留三个完整入口，并把响应式外观交给语义 class", () => {
    for (const label of ["项目日历", "任务甘特", "执行日程"]) {
      expect(planningClient).toContain(label);
    }
    expect(planningClient).toContain("className={styles.planningShell}");
    expect(planningClient).toContain("className={styles.planningViewTab}");
    expect(planningClient).toContain("className={styles.planningTabLabel}");
    expect(planningClient).not.toContain('border: `1px solid ${mode === id');
  });

  it("任务甘特保留全部粒度和状态，并把控制条接到可换行 class", () => {
    expect(ganttView).toContain('aria-label="时间轴粒度"');
    expect(ganttView).toContain('aria-label="任务状态图例"');
    for (const option of ['["day", "日"]', '["month", "月"]', '["quarter", "季"]', '["year", "年"]']) {
      expect(ganttView).toContain(option);
    }
    for (const label of ["进行中", "待处理", "受阻", "完成"]) {
      expect(ganttView).toContain(label);
    }
    expect(ganttView).toContain("className={styles.ganttControls}");
    expect(ganttView).toContain("className={styles.ganttScaleButton}");
    expect(ganttView).toContain("className={styles.ganttLegend}");
    expect(ganttView).toContain('role="separator"');
    expect(ganttView).toContain('aria-label="调整名称列宽度"');
    expect(ganttView.match(/styles\.ganttGridRow/g)).toHaveLength(3);
  });

  it("760px 以下压缩卡片，粒度控件四等分收紧视觉高度并保留触控面", () => {
    const mobileStart = css.indexOf("@media (max-width: 760px)");
    const mobileEnd = css.indexOf("@media (max-width: 520px)");
    expect(mobileStart).toBeGreaterThan(-1);
    expect(mobileEnd).toBeGreaterThan(mobileStart);
    const mobileRules = css.slice(mobileStart, mobileEnd);
    expect(mobileRules).toMatch(/\.planningViewTab \{[^}]*min-height: 44px;[^}]*padding: 7px 6px;/);
    expect(mobileRules).toMatch(/\.ganttPanel \{ padding: 14px 10px; \}/);
    expect(mobileRules).toMatch(/\.ganttControls \{[^}]*width: 100%;[^}]*flex-shrink: 1;/);
    expect(mobileRules).toMatch(/\.ganttScale \{[^}]*width: 100%;[^}]*height: 34px;[^}]*box-sizing: border-box;[^}]*padding: 1px;[^}]*overflow: visible;/);
    expect(mobileRules).toMatch(/\.ganttScaleButton \{[^}]*min-width: 0;[^}]*min-height: 44px;[^}]*margin-block: -6px;[^}]*padding: 7px 8px;[^}]*align-items: center;[^}]*justify-content: center;[^}]*flex: 1 1 0;[^}]*line-height: 1;/);
    expect(mobileRules).toMatch(/\.ganttScaleButton::before \{[^}]*inset: 7px 0;[^}]*border-radius: 5px;/);
    expect(mobileRules).toMatch(/\.ganttScaleButton\[aria-pressed="true"\] \{ background: transparent; \}/);
    expect(mobileRules).toMatch(/\.ganttScaleButton\[aria-pressed="true"\]::before \{ background: var\(--ink\); \}/);
    expect(mobileRules).toMatch(/\.ganttLegend \{[^}]*width: 100%;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*display: grid;/);
  });

  it("桌面默认尺寸保持原有页签与甘特控制条布局", () => {
    const desktopRules = css.slice(0, css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(desktopRules).toMatch(/\.planningViewTab \{[^}]*min-height: 62px;[^}]*padding: 12px 15px;/);
    expect(desktopRules).toMatch(/\.ganttPanel \{[^}]*padding: 22px;/);
    expect(desktopRules).toMatch(/\.ganttControls \{[^}]*margin-left: auto;[^}]*flex-shrink: 0;/);
    expect(desktopRules).toMatch(/\.ganttLegend \{ display: flex; gap: 12px;/);
    expect(desktopRules).toMatch(/\.ganttScaleButton \{[^}]*min-height: 30px;/);
    expect(desktopRules).toMatch(/\.ganttGridRow \{[^}]*grid-template-columns: var\(--gantt-label-column-width\) minmax\(0, 1fr\);/);
    expect(desktopRules).toMatch(/\.ganttLabelResizeHandle \{[^}]*width: 24px;[^}]*touch-action: none;/);
  });
});

describe("甘特时间轴粒度控件真实浏览器布局", () => {
  for (const width of acceptanceWidths) {
    it(`${width}px 不溢出且文字与选中态对齐`, async () => {
      await mountGanttScale(width);
      const metrics = await page.locator(".ganttScale").evaluate((scale) => {
        const buttons = [...scale.querySelectorAll<HTMLButtonElement>(".ganttScaleButton")];
        const buttonMetrics = buttons.map(button => {
          const bounds = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const textBounds = range.getBoundingClientRect();
          return {
            width: bounds.width,
            height: bounds.height,
            centerOffset: Math.abs((textBounds.top + textBounds.bottom) / 2 - (bounds.top + bounds.bottom) / 2),
          };
        });
        const selected = buttons[1];
        const selectedVisual = getComputedStyle(selected, "::before");
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          scaleHeight: scale.getBoundingClientRect().height,
          buttonMetrics,
          selectedBackground: getComputedStyle(selected).backgroundColor,
          selectedVisualBackground: selectedVisual.backgroundColor,
          selectedVisualHeight: Number.parseFloat(selectedVisual.height),
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      for (const button of metrics.buttonMetrics) expect(button.centerOffset).toBeLessThanOrEqual(0.5);

      if (width <= 760) {
        expect(metrics.scaleHeight).toBe(34);
        expect(metrics.buttonMetrics.every(button => button.height >= 44)).toBe(true);
        expect(Math.max(...metrics.buttonMetrics.map(button => button.width)) - Math.min(...metrics.buttonMetrics.map(button => button.width))).toBeLessThanOrEqual(0.5);
        expect(metrics.selectedBackground).toBe("rgba(0, 0, 0, 0)");
        expect(metrics.selectedVisualBackground).toBe("rgb(23, 37, 35)");
        expect(metrics.selectedVisualHeight).toBe(30);
      } else {
        expect(metrics.buttonMetrics.every(button => button.height === 30)).toBe(true);
      }
    });
  }
});
