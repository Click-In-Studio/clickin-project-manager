import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const component = readFileSync("components/admin/AdminFinanceClient.tsx", "utf8");
const css = readFileSync("components/admin/admin-finance.module.css", "utf8");
const acceptanceWidths = [319, 385, 768, 1280] as const;

let browser: Browser;
let page: Page;

async function mountFinanceSettings(width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --paper: #f6f5f1;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
      }
      button {
        padding: 10px 14px;
        border: 1px solid var(--ink);
        border-radius: 8px;
        background: transparent;
        color: var(--ink);
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
      }
      ${css}
    </style>
    <main class="page">
      <header data-page-header>项目名称<br><strong>财务设置</strong></header>
      <section class="currencyCard">项目记账本位币</section>
      <section>
        <div class="entryRow" data-kind="budget">
          <div class="budgetInfo">
            <strong class="entryTitle">海外联合制作舞台机械设备运输与安装费用</strong>
            <span class="entryAmount">USD $123,456.78 → CNY ¥890,123.45</span>
          </div>
          <div class="entryActions">
            <button disabled>上移</button><button>下移</button><button>编辑</button><button>删除</button>
          </div>
        </div>
        <div class="entryRow" data-kind="category">
          <div class="categoryInfo">
            <div class="categoryCopy"><strong class="entryTitle">舞台机械设备运输与安装</strong><p>包含跨境运输、安装和调试</p></div>
            <span class="entryMeta">12 个预算项</span>
          </div>
          <div class="entryActions">
            <button>上移</button><button disabled>下移</button><button>编辑</button><button>删除</button>
          </div>
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

describe("后台财务设置响应式布局", () => {
  it("预算项和费用科目使用独立的主信息区与操作区，同时保留操作顺序和禁用条件", () => {
    expect(component).toContain("className={styles.budgetInfo}");
    expect(component).toContain("className={styles.categoryInfo}");
    expect(component.match(/className=\{styles\.entryActions\}/g)).toHaveLength(2);

    const itemActions = component.slice(component.indexOf("className={styles.entryActions}"), component.indexOf("</div>", component.indexOf("className={styles.entryActions}")));
    const actionPositions = ["上移", "下移", "编辑", "删除"].map(label => itemActions.indexOf(label));
    expect(actionPositions.every(position => position >= 0)).toBe(true);
    expect(actionPositions).toEqual([...actionPositions].sort((a, b) => a - b));
    expect(itemActions).toContain("disabled={index === 0 || busy}");
    expect(itemActions).toContain("disabled={index === group.items.length - 1 || busy}");
    expect(component).toContain('onClick={() => setModal({ kind: "item", value: item })}');
    expect(component).toContain("onClick={() => removeItem(item)}");
    expect(component).toContain('onClick={() => setModal({ kind: "category", value: category })}');
    expect(component).toContain("onClick={() => removeCategory(category)}");
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下标题、币种和金额完整呈现，条目不造成页面横向溢出`, async () => {
      await mountFinanceSettings(width);
      const metrics = await page.locator(".page").evaluate(root => {
        const rows = [...root.querySelectorAll<HTMLElement>(".entryRow")];
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          rows: rows.map(row => {
            const info = row.firstElementChild as HTMLElement;
            const actions = row.querySelector<HTMLElement>(".entryActions")!;
            const infoBounds = info.getBoundingClientRect();
            const actionBounds = actions.getBoundingClientRect();
            return {
              columns: getComputedStyle(row).gridTemplateColumns.split(" ").length,
              infoBottom: infoBounds.bottom,
              actionsTop: actionBounds.top,
              titleFits: [...row.querySelectorAll<HTMLElement>(".entryTitle")]
                .every(element => element.scrollWidth <= element.clientWidth),
              amountFits: [...row.querySelectorAll<HTMLElement>(".entryAmount, .entryMeta")]
                .every(element => element.scrollWidth <= element.clientWidth),
              actionLabels: [...actions.querySelectorAll("button")].map(button => button.textContent),
            };
          }),
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      for (const row of metrics.rows) {
        expect(row.titleFits).toBe(true);
        expect(row.amountFits).toBe(true);
        expect(row.actionLabels).toEqual(["上移", "下移", "编辑", "删除"]);
        if (width <= 680) {
          expect(row.columns).toBe(1);
          expect(row.actionsTop).toBeGreaterThanOrEqual(row.infoBottom);
        } else {
          expect(row.columns).toBe(2);
        }
      }
    });
  }

  it("319px 将主信息自身上下排布，385px 保留标题与金额双列", async () => {
    await mountFinanceSettings(319);
    expect(await page.locator(".budgetInfo").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
    await mountFinanceSettings(385);
    expect(await page.locator(".budgetInfo").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
  });

  it("卡片留白按约定收紧，手机页头顶距与项目首页一致", async () => {
    await mountFinanceSettings(385);
    const mobile = await page.locator(".page").evaluate(root => {
      const row = root.querySelector<HTMLElement>(".entryRow")!;
      const card = root.querySelector<HTMLElement>(".currencyCard")!;
      return {
        pagePadding: getComputedStyle(root).padding,
        rowPadding: getComputedStyle(row).padding,
        cardPadding: getComputedStyle(card).padding,
      };
    });
    expect(mobile).toEqual({
      pagePadding: "20px 14px 80px",
      rowPadding: "11px 13px",
      cardPadding: "14px",
    });

    await mountFinanceSettings(768);
    expect(await page.locator(".page").evaluate(root => getComputedStyle(root).paddingTop)).toBe("24px");
  });
});
