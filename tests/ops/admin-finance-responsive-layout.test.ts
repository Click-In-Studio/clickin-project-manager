import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const component = readFileSync("components/admin/AdminFinanceClient.tsx", "utf8");
const css = readFileSync("components/admin/admin-finance.module.css", "utf8");
const acceptanceWidths = [319, 370, 680, 768, 1280] as const;

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
      <nav class="tabs">
        <button class="compactButton" style="padding: 4px 14px; line-height: 18px">预算项</button>
        <button class="compactButton" style="padding: 4px 14px; line-height: 18px">费用科目</button>
      </nav>
      <section class="currencyCard">
        <strong>项目记账本位币</strong>
        <button class="ofs-trigger currencySelect" role="combobox" style="display: flex; width: 180px; max-width: 100%; padding: 4px 8px; line-height: 18px; overflow: hidden">
          <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis">阿联酋迪拉姆超长币种名称（AED）</span><span>▾</span>
        </button>
      </section>
      <section>
        <div class="entryRow" data-kind="budget">
          <div class="budgetInfo">
            <strong class="entryTitle">海外联合制作舞台机械设备运输与安装费用</strong>
            <span class="entryAmount">USD $123,456.78 → CNY ¥890,123.45</span>
          </div>
          <div class="entryActions">
            <button class="compactButton" style="padding: 4px 12px; line-height: 18px" disabled>上移</button><button class="compactButton" style="padding: 4px 12px; line-height: 18px">下移</button><button class="compactButton" style="padding: 4px 12px; line-height: 18px">编辑</button><button class="compactButton" style="padding: 4px 12px; line-height: 18px">删除</button>
          </div>
        </div>
        <div class="entryRow" data-kind="category">
          <div class="categoryInfo">
            <div class="categoryCopy"><strong class="entryTitle">舞台机械设备运输与安装</strong><p>包含跨境运输、安装和调试</p></div>
            <span class="entryMeta">12 个预算项</span>
          </div>
          <div class="entryActions">
            <button class="compactButton" style="padding: 4px 12px; line-height: 18px">上移</button><button class="compactButton" style="padding: 4px 12px; line-height: 18px" disabled>下移</button><button class="compactButton" style="padding: 4px 12px; line-height: 18px">编辑</button><button class="compactButton" style="padding: 4px 12px; line-height: 18px">删除</button>
          </div>
        </div>
      </section>
      <div class="currencyMenu" data-overflow-safe-select-menu role="listbox" style="position: fixed; left: 10px; top: 620px; width: min(220px, calc(100vw - 20px)); border: 1px solid var(--line)">
        <button class="currencyOption" role="option" style="display: flex; width: 100%; border: 0"><span>这是一个用于验证极窄屏幕安全换行的超长币种名称（LONG）</span></button>
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
    expect(component).toContain("<OverflowSafeSelect");
    expect(component).toContain("menuClassName={styles.currencyMenu}");
    expect(component).toContain("optionClassName={styles.currencyOption}");
    expect(component.match(/<option key=\{code\} value=\{code\}>\{formatCurrencyLabel\(code\)\}<\/option>/g)).toHaveLength(2);

    const buttons = [...component.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every(button => button.includes("className={styles.compactButton}"))).toBe(true);
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下条目与币种菜单不造成横向溢出，紧凑按钮不互相挤压`, async () => {
      await mountFinanceSettings(width);
      const metrics = await page.locator(".page").evaluate(root => {
        const rows = [...root.querySelectorAll<HTMLElement>(".entryRow")];
        const currencyTrigger = root.querySelector<HTMLElement>(".currencySelect")!;
        const currencyMenu = root.querySelector<HTMLElement>(".currencyMenu")!;
        const menuOption = currencyMenu.querySelector<HTMLElement>("[role=option]")!;
        const triggerBounds = currencyTrigger.getBoundingClientRect();
        const menuBounds = currencyMenu.getBoundingClientRect();
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          currency: {
            triggerLeft: triggerBounds.left,
            triggerRight: triggerBounds.right,
            menuLeft: menuBounds.left,
            menuRight: menuBounds.right,
            menuOptionFits: menuOption.scrollWidth <= menuOption.clientWidth,
          },
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
              buttonHeights: [...actions.querySelectorAll("button")].map(button => button.getBoundingClientRect().height),
              buttonGaps: [...actions.querySelectorAll("button")].slice(1).map((button, index) => {
                const previous = actions.querySelectorAll("button")[index]!.getBoundingClientRect();
                const current = button.getBoundingClientRect();
                return current.top === previous.top ? current.left - previous.right : current.top - previous.bottom;
              }),
            };
          }),
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.currency.triggerLeft).toBeGreaterThanOrEqual(0);
      expect(metrics.currency.triggerRight).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.currency.menuLeft).toBeGreaterThanOrEqual(0);
      expect(metrics.currency.menuRight).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.currency.menuOptionFits).toBe(true);
      for (const row of metrics.rows) {
        expect(row.titleFits).toBe(true);
        expect(row.amountFits).toBe(true);
        expect(row.actionLabels).toEqual(["上移", "下移", "编辑", "删除"]);
        expect(row.buttonHeights.every(height => height === 28)).toBe(true);
        expect(row.buttonGaps.every(gap => gap >= 8)).toBe(true);
        if (width <= 680) {
          expect(row.columns).toBe(1);
          expect(row.actionsTop).toBeGreaterThanOrEqual(row.infoBottom);
        } else {
          expect(row.columns).toBe(2);
        }
      }
    });
  }

  it("319px 将主信息自身上下排布，370px 保留标题与金额双列", async () => {
    await mountFinanceSettings(319);
    expect(await page.locator(".budgetInfo").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
    await mountFinanceSettings(370);
    expect(await page.locator(".budgetInfo").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
  });

  it("按钮视觉高度约为共享默认值的 5/7，同时保留约 40px 的纵向点击区域", async () => {
    await mountFinanceSettings(370);
    const dimensions = await page.locator(".entryActions .compactButton").first().evaluate(element => {
      const visualHeight = element.getBoundingClientRect().height;
      const hitArea = getComputedStyle(element, "::before");
      return {
        visualHeight,
        hitHeight: visualHeight - Number.parseFloat(hitArea.top) - Number.parseFloat(hitArea.bottom),
        lineHeight: getComputedStyle(element).lineHeight,
      };
    });
    expect(dimensions.visualHeight).toBe(28);
    expect(dimensions.visualHeight / 40).toBeCloseTo(5 / 7, 1);
    expect(dimensions.hitHeight).toBeGreaterThanOrEqual(40);
    expect(dimensions.lineHeight).toBe("18px");
  });

  it("卡片留白按约定收紧，手机页头顶距与项目首页一致", async () => {
    await mountFinanceSettings(370);
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
