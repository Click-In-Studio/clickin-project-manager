import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const css = readFileSync("components/admin/admin-permission-center.module.css", "utf8");
const acceptanceWidths = [319, 370, 605, 768, 1200] as const;

let browser: Browser;
let page: Page;

async function mountTabs(width: number) {
  await page.setViewportSize({ width, height: 720 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --surface-2: #eef0ef;
        --ink: #172523;
        --muted: #66736f;
        --stage: #28786d;
      }
      ${css}
    </style>
    <main style="padding: 24px clamp(18px, 3vw, 52px) 60px">
      <div class="tabList" role="tablist" aria-label="权限类型">
        <button class="tab" role="tab" aria-selected="true">部门权限</button>
        <button class="tab" role="tab" aria-selected="false">角色权限</button>
        <button class="tab" role="tab" aria-selected="false">人事权限</button>
        <button class="tab" role="tab" aria-selected="false">资源审批人</button>
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

describe("权限中心顶部页签真实浏览器布局", () => {
  for (const width of acceptanceWidths) {
    it(`${width}px 下四个页签保持单行且不产生页面级横向滚动`, async () => {
      await mountTabs(width);
      const metrics = await page.locator(".tabList").evaluate((tabList) => {
        const listBounds = tabList.getBoundingClientRect();
        const tabs = [...tabList.querySelectorAll<HTMLElement>(".tab")];
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          listLeft: listBounds.left,
          listRight: listBounds.right,
          listClientWidth: tabList.clientWidth,
          listScrollWidth: tabList.scrollWidth,
          overflowX: getComputedStyle(tabList).overflowX,
          tabs: tabs.map(tab => ({
            whiteSpace: getComputedStyle(tab).whiteSpace,
            height: tab.clientHeight,
            scrollHeight: tab.scrollHeight,
            textFits: tab.scrollWidth <= tab.clientWidth,
          })),
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.listLeft).toBeGreaterThanOrEqual(0);
      expect(metrics.listRight).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.listScrollWidth).toBeLessThanOrEqual(metrics.listClientWidth);
      expect(metrics.overflowX).toBe("auto");
      for (const tab of metrics.tabs) {
        expect(tab.whiteSpace).toBe("nowrap");
        expect(tab.scrollHeight).toBeLessThanOrEqual(tab.height);
        expect(tab.textFits).toBe(true);
      }
    });
  }

  it("空间比 319px 更窄时只在页签容器内部滚动，并能将选中项带入视野", async () => {
    await mountTabs(240);
    const metrics = await page.locator(".tabList").evaluate((tabList) => {
      const lastTab = tabList.querySelectorAll<HTMLElement>(".tab").item(3);
      lastTab.setAttribute("aria-selected", "true");
      tabList.querySelector<HTMLElement>('.tab[aria-selected="true"]:not(:last-child)')?.setAttribute("aria-selected", "false");
      lastTab.scrollIntoView({ block: "nearest", inline: "nearest" });
      const listBounds = tabList.getBoundingClientRect();
      const tabBounds = lastTab.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        listClientWidth: tabList.clientWidth,
        listScrollWidth: tabList.scrollWidth,
        selectedLeft: tabBounds.left,
        selectedRight: tabBounds.right,
        listLeft: listBounds.left,
        listRight: listBounds.right,
      };
    });

    expect(metrics.listScrollWidth).toBeGreaterThan(metrics.listClientWidth);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.selectedLeft).toBeGreaterThanOrEqual(metrics.listLeft - 0.5);
    expect(metrics.selectedRight).toBeLessThanOrEqual(metrics.listRight + 0.5);
  });

  it("键盘焦点有清晰轮廓，触摸点击不会触发额外延迟手势", async () => {
    await mountTabs(319);
    const firstTab = page.locator(".tab").first();
    await firstTab.focus();
    const styles = await firstTab.evaluate(tab => ({
      outlineStyle: getComputedStyle(tab).outlineStyle,
      outlineWidth: getComputedStyle(tab).outlineWidth,
      touchAction: getComputedStyle(tab).touchAction,
    }));

    expect(styles.outlineStyle).not.toBe("none");
    expect(styles.outlineWidth).toBe("2px");
    expect(styles.touchAction).toBe("manipulation");
  });
});
