import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const homeCss = readFileSync(path.resolve(__dirname, "../../components/ops/home.module.css"), "utf8");
const viewportWidths = [319, 360, 385, 571, 765, 1118];

let browser: Browser;
let page: Page;

async function mountProgressMetrics(width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      :root { --ink: #172523; }
      body { margin: 0; }
      ${homeCss}
    </style>
    <main class="workspace">
      <section class="progressHero">
        <div class="progressHeroIntro">
          <p class="progressEyebrow">PROJECT PROGRESS · 项目进展</p>
          <h2 class="progressHeroTitle">联合排练安排</h2>
        </div>
        <div class="progressHeroMetrics">
          <div class="progressMetricCard progressMetricUrgent">
            <strong>3 天</strong>
            <div class="progressMetricDisclosure">
              <button
                type="button"
                class="progressMetricLabel"
                aria-expanded="false"
                onclick="this.setAttribute('aria-expanded', String(this.nextElementSibling.hidden)); this.nextElementSibling.hidden = !this.nextElementSibling.hidden"
              >距「技术合成与全体演员联合走台确认」</button>
              <div class="progressMetricDisclosurePanel" hidden>距「技术合成与全体演员联合走台确认」</div>
            </div>
            <small>临近节点</small>
          </div>
          <a href="/notifications" class="progressMetricCard progressMetricLink progressMetricActive">
            <strong>12</strong>
            <span class="progressMetricLabel">待处理通知</span>
          </a>
          <a href="/cues" class="progressMetricCard progressMetricLink progressMetricWarn">
            <strong>8</strong>
            <span class="progressMetricLabel">Cue 风险提示</span>
          </a>
        </div>
      </section>
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

describe("项目首页进展指标卡真实浏览器布局", () => {
  for (const width of viewportWidths) {
    it(`${width}px 下三卡同排同高且不重叠越界`, async () => {
      await mountProgressMetrics(width);
      const metrics = await page.locator(".progressHeroMetrics").evaluate(grid => {
        const gridBounds = grid.getBoundingClientRect();
        const cards = [...grid.querySelectorAll<HTMLElement>(".progressMetricCard")];
        return {
          columnCount: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          gridBounds: { left: gridBounds.left, right: gridBounds.right },
          cards: cards.map(card => {
            const bounds = card.getBoundingClientRect();
            const label = card.querySelector<HTMLElement>(".progressMetricLabel");
            return {
              left: bounds.left,
              right: bounds.right,
              height: bounds.height,
              scrollWidth: card.scrollWidth,
              clientWidth: card.clientWidth,
              labelScrollWidth: label?.scrollWidth ?? 0,
              labelClientWidth: label?.clientWidth ?? 0,
            };
          }),
        };
      });

      expect(metrics.columnCount).toBe(3);
      expect(new Set(metrics.cards.map(card => card.height)).size).toBe(1);
      expect(metrics.cards[0].left).toBeGreaterThanOrEqual(metrics.gridBounds.left);
      expect(metrics.cards[2].right).toBeLessThanOrEqual(metrics.gridBounds.right);
      expect(metrics.cards[0].right).toBeLessThanOrEqual(metrics.cards[1].left);
      expect(metrics.cards[1].right).toBeLessThanOrEqual(metrics.cards[2].left);
      for (const card of metrics.cards) {
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      }
      for (const card of metrics.cards.slice(1)) {
        expect(card.labelScrollWidth).toBeLessThanOrEqual(card.labelClientWidth);
      }
    });
  }

  it("里程碑卡的整张卡面属于展开按钮的点击区域", async () => {
    await mountProgressMetrics(319);
    const target = await page.locator(".progressMetricCard").first().evaluate(card => {
      const bounds = card.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.right - 6, bounds.top + 6);
      return hit?.tagName;
    });

    expect(target).toBe("BUTTON");
  });

  for (const width of viewportWidths) {
    it(`${width}px 下点击后完整里程碑不被裁剪且可命中`, async () => {
      await mountProgressMetrics(width);
      await page.locator(".progressMetricLabel").first().click();

      const disclosure = await page.locator(".progressMetricDisclosurePanel").evaluate(panel => {
        const bounds = panel.getBoundingClientRect();
        const clippedBy: string[] = [];
        let ancestor = panel.parentElement;

        while (ancestor) {
          const style = getComputedStyle(ancestor);
          const ancestorBounds = ancestor.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)
            && (bounds.left < ancestorBounds.left || bounds.right > ancestorBounds.right)) {
            clippedBy.push(`${ancestor.className || ancestor.tagName}:x`);
          }
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)
            && (bounds.top < ancestorBounds.top || bounds.bottom > ancestorBounds.bottom)) {
            clippedBy.push(`${ancestor.className || ancestor.tagName}:y`);
          }
          ancestor = ancestor.parentElement;
        }

        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return {
          hidden: (panel as HTMLElement).hidden,
          clippedBy,
          withinViewport: bounds.left >= 0
            && bounds.top >= 0
            && bounds.right <= window.innerWidth
            && bounds.bottom <= window.innerHeight,
          fullyRendered: panel.scrollWidth <= panel.clientWidth && panel.scrollHeight <= panel.clientHeight,
          hitPanel: hit === panel || panel.contains(hit),
        };
      });

      expect(disclosure.hidden).toBe(false);
      expect(disclosure.clippedBy).toEqual([]);
      expect(disclosure.withinViewport).toBe(true);
      expect(disclosure.fullyRendered).toBe(true);
      expect(disclosure.hitPanel).toBe(true);
      expect(await page.locator(".progressMetricLabel").first().getAttribute("aria-expanded")).toBe("true");
    });
  }

  it("桌面卡片随字号增大，并且仍由内容决定最终高度", async () => {
    await mountProgressMetrics(571);
    const mobile = await page.locator(".progressMetricCard").first().evaluate(card => ({
      height: card.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(card.querySelector("strong")!).fontSize),
    }));
    await mountProgressMetrics(1118);
    const desktop = await page.locator(".progressMetricCard").first().evaluate(card => ({
      height: card.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(card.querySelector("strong")!).fontSize),
      declaredHeight: getComputedStyle(card).height,
      scrollHeight: card.scrollHeight,
    }));

    expect(desktop.fontSize).toBeGreaterThan(mobile.fontSize);
    expect(desktop.height).toBeGreaterThan(mobile.height);
    expect(desktop.scrollHeight).toBeLessThanOrEqual(desktop.height);
    expect(Number.parseFloat(desktop.declaredHeight)).toBeCloseTo(desktop.height, 2);
  });

  it("765px 下指标区收至原来的约五分之七，Hero 收至原来的约八分之七", async () => {
    await mountProgressMetrics(765);
    const metrics = await page.locator(".progressHero").evaluate(hero => {
      const heroBounds = hero.getBoundingClientRect();
      const grid = hero.querySelector<HTMLElement>(".progressHeroMetrics")!;
      const gridBounds = grid.getBoundingClientRect();
      const firstCard = grid.querySelector<HTMLElement>(".progressMetricCard")!;
      const number = firstCard.querySelector<HTMLElement>("strong")!;
      const label = firstCard.querySelector<HTMLElement>(".progressMetricLabel")!;

      return {
        heroHeight: heroBounds.height,
        gridWidth: gridBounds.width,
        numberSize: Number.parseFloat(getComputedStyle(number).fontSize),
        labelSize: Number.parseFloat(getComputedStyle(label).fontSize),
      };
    });

    expect(metrics.gridWidth).toBeCloseTo(300, 1);
    expect(metrics.heroHeight).toBeCloseTo(175, 1);
    expect(metrics.numberSize).toBeCloseTo(32, 1);
    expect(metrics.labelSize).toBeCloseTo(11, 1);
  });
});
