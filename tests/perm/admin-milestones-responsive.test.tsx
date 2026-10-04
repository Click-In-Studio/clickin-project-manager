import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const component = readFileSync("components/admin/AdminMilestonesClient.tsx", "utf8");
const css = readFileSync("components/admin/admin-milestones.module.css", "utf8");
const acceptanceWidths = [319, 370, 768, 1180] as const;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function mountMilestones(width: number) {
  await page.setViewportSize({ width, height: 760 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; margin: 0; }
      :root {
        --paper: #f6f5f1;
        --surface: #fff;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
        --stage: #8b5c43;
        --danger: #b42318;
      }
      ${css}
    </style>
    <main class="page">
      <div class="pageContent">
        <section class="addCard">
          <p class="eyebrow">New Milestone</p>
          <h2 class="addTitle">新增里程碑</h2>
          <div class="addFields">
            <input class="input newNameInput" placeholder="里程碑名称，例如「首演」「联排开始」">
            <input class="input newDateInput" type="date">
            <button class="addButton">添加</button>
          </div>
        </section>
        <article class="milestoneRow">
          <div class="displayRow">
            <div class="milestoneCopy">
              <div class="titleLine">
                <span class="currentLabel">当前</span>
                <span class="milestoneName" title="这是一个非常非常长且需要明确截断的里程碑名称">这是一个非常非常长且需要明确截断的里程碑名称</span>
              </div>
              <div class="metaLine">
                <span class="milestoneDate">2026 年 10 月 24 日</span>
                <span class="countdown">20 天后</span>
              </div>
            </div>
            <div class="rowActions">
              <button class="rowAction">编辑</button><button class="rowAction deleteAction">删除</button>
            </div>
          </div>
        </article>
      </div>
    </main>
  `);
}

describe("配置中心里程碑响应式布局", () => {
  it("真实组件接入页面局部样式且名称提供明确省略规则", () => {
    expect(component).toContain('import styles from "./admin-milestones.module.css"');
    for (const className of [
      "pageContent",
      "addFields",
      "newNameInput",
      "newDateInput",
      "milestoneRow",
      "displayRow",
      "milestoneName",
      "metaLine",
      "rowActions",
      "rowAction",
    ]) {
      expect(component).toContain(`styles.${className}`);
    }
    expect(css).toMatch(/\.milestoneName\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下操作与信息保持同排且页面无横向溢出`, async () => {
      await mountMilestones(width);
      const metrics = await page.locator(".milestoneRow").evaluate(row => {
        const actionButtons = [...row.querySelectorAll<HTMLElement>(".rowAction")].map(button => button.getBoundingClientRect());
        const actions = row.querySelector<HTMLElement>(".rowActions")!;
        const name = row.querySelector<HTMLElement>(".milestoneName")!;
        const metaLine = row.querySelector<HTMLElement>(".metaLine")!;
        const rowBounds = row.getBoundingClientRect();
        const actionStyle = getComputedStyle(row.querySelector<HTMLElement>(".rowAction")!);
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          row: { left: rowBounds.left, right: rowBounds.right },
          actionTops: actionButtons.map(button => button.top),
          actionsRight: actions.getBoundingClientRect().right,
          actionGap: Number.parseFloat(getComputedStyle(actions).gap || "0"),
          actionPaddingLeft: Number.parseFloat(actionStyle.paddingLeft),
          metaFlexWrap: getComputedStyle(metaLine).flexWrap,
          nameWhiteSpace: getComputedStyle(name).whiteSpace,
          nameOverflow: getComputedStyle(name).overflow,
          nameTextOverflow: getComputedStyle(name).textOverflow,
          nameIsTruncated: name.scrollWidth > name.clientWidth,
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.row.left).toBeGreaterThanOrEqual(0);
      expect(metrics.row.right).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.actionTops[0]).toBe(metrics.actionTops[1]);
      expect(metrics.actionsRight).toBeLessThanOrEqual(metrics.row.right);
      expect(metrics.metaFlexWrap).toBe("nowrap");
      expect(metrics.nameWhiteSpace).toBe("nowrap");
      expect(metrics.nameOverflow).toBe("hidden");
      expect(metrics.nameTextOverflow).toBe("ellipsis");

      if (width <= 480) {
        expect(metrics.actionGap).toBe(0);
        expect(metrics.actionPaddingLeft).toBe(4);
        expect(metrics.nameIsTruncated).toBe(true);
      } else {
        expect(metrics.actionGap).toBe(4);
        expect(metrics.actionPaddingLeft).toBe(8);
      }
    });
  }

  it("新增名称与日期输入框缩至原高度约 5/6", async () => {
    await mountMilestones(319);
    const sizes = await page.locator(".addFields").evaluate(fields => {
      const name = fields.querySelector<HTMLInputElement>(".newNameInput")!;
      const date = fields.querySelector<HTMLInputElement>(".newDateInput")!;
      const style = getComputedStyle(name);
      return {
        nameHeight: name.getBoundingClientRect().height,
        dateHeight: date.getBoundingClientRect().height,
        fontSize: Number.parseFloat(style.fontSize),
        paddingTop: Number.parseFloat(style.paddingTop),
      };
    });

    expect(sizes.nameHeight).toBeGreaterThanOrEqual(27);
    expect(sizes.nameHeight).toBeLessThanOrEqual(29);
    expect(sizes.dateHeight).toBeGreaterThanOrEqual(27);
    expect(sizes.dateHeight).toBeLessThanOrEqual(29);
    expect(sizes.fontSize).toBe(12);
    expect(sizes.paddingTop).toBe(6);
  });
});
