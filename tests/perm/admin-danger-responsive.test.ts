import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const css = readFileSync("components/admin/admin-danger.module.css", "utf8");
const browserCss = css.replace(/:global\(([^)]+)\)/g, "$1");
const dangerPage = readFileSync("app/production/[id]/admin/danger/page.tsx", "utf8");
const dangerCard = readFileSync("components/admin/AdminSettingsClient.tsx", "utf8");
const transferCard = readFileSync("components/admin/TransferOwnerCard.tsx", "utf8");

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
        <div class="page">
          <a class="mobileBack" href="#project">← 返回项目</a>
          <section class="transferCard">
            <div class="transferControls">
              <button class="ownerPicker">选择新 Owner…</button>
              <input class="ownerConfirmInput" placeholder="输入姓名以确认">
              <button class="ownerConfirmButton">确认转让</button>
            </div>
          </section>
          <section class="dangerCard">
            <div class="dangerHeader"><p>危险区域</p></div>
            <div class="dangerRow">
              <div class="dangerLabel"><p>归档项目</p><small>标记为归档，成员只读，不再出现于常用列表</small></div>
              <div class="dangerControl"><button>归档</button></div>
            </div>
            <div class="dangerRow">
              <div class="dangerLabel"><p>删除项目</p><small>彻底删除项目及所有数据，不可撤销</small></div>
              <div class="dangerControl">
                <div class="deleteConfirmRow"><input placeholder="项目名称"><button>确认删除</button></div>
              </div>
            </div>
          </section>
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
  it("页面、危险区域和 Owner 转让使用独立样式钩子，不修改全局 AppShell", () => {
    expect(dangerPage).toContain("className={styles.page}");
    expect(dangerPage).toContain("className={styles.mobileBack}");
    expect(dangerCard).toContain("className={dangerStyles.dangerRow}");
    expect(dangerCard).toContain("className={dangerStyles.deleteConfirmRow}");
    expect(transferCard).toContain("className={styles.transferControls}");
  });

  for (const width of [319, 375, 768, 1280]) {
    it(`${width}px 下内容不横向溢出且返回入口落在正确位置`, async () => {
      await mountDangerPage(width);
      const metrics = await page.locator(".page").evaluate((root) => {
        const row = root.querySelector<HTMLElement>(".dangerRow")!;
        const deleteRow = root.querySelector<HTMLElement>(".deleteConfirmRow")!;
        const transfer = root.querySelector<HTMLElement>(".transferControls")!;
        const back = root.querySelector<HTMLElement>(".mobileBack")!;
        return {
          columns: getComputedStyle(row).gridTemplateColumns.split(" ").length,
          deleteDirection: getComputedStyle(deleteRow).flexDirection,
          transferDisplay: getComputedStyle(transfer).display,
          backDisplay: getComputedStyle(back).display,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
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
