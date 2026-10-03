import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const component = readFileSync("components/perm/ContactsClient.tsx", "utf8");
const css = readFileSync("components/perm/contacts.module.css", "utf8");
const acceptanceWidths = [319, 360, 571, 768, 1118] as const;
const expectedColumns = [2, 2, 3, 5, 7] as const;

let browser: Browser;
let page: Page;

async function mountRoster(width: number) {
  await page.setViewportSize({ width, height: 720 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --paper: #f6f5f1;
        --surface: #fff;
        --surface-2: #eef0ef;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
        --danger-soft: #fbe9e9;
        --danger: #a83232;
        --script-soft: #eeeaf8;
        --script: #5c527f;
      }
      ${css}
    </style>
    <main class="page">
      <section class="panel">
        <div class="memberGrid">
          <article class="memberCard">
            <div class="avatar"><span class="avatarFallback">亚</span></div>
            <div class="memberDetails">
              <p class="memberName">
                <span class="memberNameText">亚历山大·汉密尔顿</span>
                <span class="statusBadge">已停用</span>
              </p>
              <div class="badgeRow roleRow"><span class="badge">舞台监督</span></div>
              <div class="badgeRow tagRow"><span class="badge tagBadge">外部协作人员</span></div>
              <p class="email">alexander.hamilton@example.com</p>
            </div>
          </article>
          <article class="memberCard">
            <div class="avatar"><span class="avatarFallback">李</span></div>
            <div class="memberDetails"><p class="memberName"><span class="memberNameText">李四</span></p></div>
          </article>
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

describe("人员名册响应式卡片", () => {
  it("页面仍然只提供名册展示，并沿用人员域样式", () => {
    expect(component).toContain("className={styles.memberGrid}");
    expect(component).toContain("className={styles.memberNameText}");
    expect(component).toContain("className={styles.statusBadge}");
    expect(component).not.toMatch(/<button|<input|<form|contentEditable/);
  });

  for (const [index, width] of acceptanceWidths.entries()) {
    it(`${width}px 下长姓名和停用标记保持在当前卡片内`, async () => {
      await mountRoster(width);
      const metrics = await page.locator(".memberGrid").evaluate((grid) => {
        const cards = [...grid.querySelectorAll<HTMLElement>(".memberCard")];
        const firstCard = cards[0].getBoundingClientRect();
        const nextCard = cards[1].getBoundingClientRect();
        const name = grid.querySelector<HTMLElement>(".memberNameText")!;
        const status = grid.querySelector<HTMLElement>(".statusBadge")!;
        const nameBounds = name.getBoundingClientRect();
        const statusBounds = status.getBoundingClientRect();
        return {
          columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          cardLeft: firstCard.left,
          cardRight: firstCard.right,
          nextCardLeft: nextCard.left,
          nameLeft: nameBounds.left,
          nameRight: nameBounds.right,
          nameWhiteSpace: getComputedStyle(name).whiteSpace,
          statusLeft: statusBounds.left,
          statusRight: statusBounds.right,
        };
      });

      expect(metrics.columns).toBe(expectedColumns[index]);
      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.nameWhiteSpace).toBe("nowrap");
      expect(metrics.nameLeft).toBeGreaterThanOrEqual(metrics.cardLeft - 0.5);
      expect(metrics.nameRight).toBeLessThanOrEqual(metrics.cardRight + 0.5);
      expect(metrics.statusLeft).toBeGreaterThanOrEqual(metrics.cardLeft - 0.5);
      expect(metrics.statusRight).toBeLessThanOrEqual(metrics.cardRight + 0.5);
      expect(metrics.statusRight).toBeLessThanOrEqual(metrics.nextCardLeft);
    });
  }
});
