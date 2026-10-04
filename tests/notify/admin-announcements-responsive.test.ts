import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const css = readFileSync("components/admin/admin-announcements.module.css", "utf8");
const browserCss = css.replace(/:global\(([^)]+)\)/g, "$1");
const acceptanceWidths = [319, 370, 651, 768, 1200] as const;

let browser: Browser;
let page: Page;

async function mountWorkspace(width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      :root {
        --paper: #f6f5f1;
        --surface: #fff;
        --surface-2: #eef0ef;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
      }
      .shell { height: 100dvh; display: flex; flex-direction: column; }
      .topbar { height: 64px; flex: 0 0 64px; }
      .shellWorkspace { min-height: 0; flex: 1; overflow: auto; }
      .bottomNav { height: 60px; flex: 0 0 60px; border-top: 1px solid var(--line); }
      .prose { font-size: 16px; line-height: 1.75; }
      .prose p { margin-block: 1.25em; }
      ${browserCss}
    </style>
    <div class="shell">
      <header class="topbar">配置中心</header>
      <main class="shellWorkspace">
        <article class="page">
          <section class="workspace">
            <aside class="listPane">
              <div class="list">
                ${Array.from({ length: 12 }, (_, index) => `
                  <button class="listItem ${index === 0 ? "listItemActive" : ""}" aria-pressed="${index === 0}" style="background:${index === 0 ? "var(--ink)" : "transparent"}">
                    <div class="listMeta">
                      ${index === 0 ? "<span>置顶</span>" : ""}
                      <span class="listDate">2026年10月3日</span>
                    </div>
                    <p class="listTitle" style="color:${index === 0 ? "white" : "var(--ink)"}">全体成员技术合成与走台安排确认</p>
                  </button>
                `).join("")}
              </div>
            </aside>
            <div class="detailPane">
              <div class="detailContent">
                <div class="detailMeta">
                  <span>发布于 2026年10月3日</span>
                  <div class="detailActions"><button>置顶</button><button>编辑</button><button>删除</button></div>
                </div>
                <h2 class="detailTitle">技术合成与全体演员联合走台确认</h2>
                <div class="detailDivider"></div>
                <div class="prose detailBody">
                  <p class="longChinese">请各部门确认技术合成当日安排并在进场前完成服装道具灯光音响及舞台机械所需准备所有成员到场后按照舞台监督通知依次完成联合走台</p>
                  ${Array.from({ length: 17 }, () => "<p>请各部门确认当日安排，并在进场前完成所需准备。</p>").join("")}
                </div>
                <div class="readStatus"><div class="detailEnd">阅读状态</div></div>
              </div>
            </div>
          </section>
        </article>
      </main>
      <nav class="bottomNav">底部导航</nav>
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

// 这里只验证 CSS 在真实 Chrome 中的几何表现；真实组件与这些 CSS Module
// class 的接线由 admin-announcements-form-saving.test.tsx 挂载组件后直接断言。
describe("公告管理响应式 CSS 浏览器几何", () => {
  for (const width of acceptanceWidths) {
    it(`${width}px 下列表、选中态、日期和详情保持可读且不横向溢出`, async () => {
      await mountWorkspace(width);
      const metrics = await page.locator(".workspace").evaluate(workspace => {
        const list = workspace.querySelector<HTMLElement>(".listPane")!;
        const active = workspace.querySelector<HTMLElement>(".listItemActive")!;
        const date = active.querySelector<HTMLElement>(".listDate")!;
        const listTitle = active.querySelector<HTMLElement>(".listTitle")!;
        const detail = workspace.querySelector<HTMLElement>(".detailPane")!;
        const detailTitle = detail.querySelector<HTMLElement>(".detailTitle")!;
        return {
          direction: getComputedStyle(workspace).flexDirection,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          listOverflowY: getComputedStyle(list).overflowY,
          listScrollable: list.scrollHeight > list.clientHeight,
          activeBackground: getComputedStyle(active).backgroundColor,
          dateWhiteSpace: getComputedStyle(date).whiteSpace,
          dateHeight: date.getBoundingClientRect().height,
          listTitleWhiteSpace: getComputedStyle(listTitle).whiteSpace,
          listTitleHeight: listTitle.getBoundingClientRect().height,
          detailOverflowY: getComputedStyle(detail).overflowY,
          detailWidth: detail.getBoundingClientRect().width,
          detailTitleWritingMode: getComputedStyle(detailTitle).writingMode,
          detailTitleWidth: detailTitle.getBoundingClientRect().width,
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.direction).toBe(width <= 767 ? "column" : "row");
      expect(metrics.listOverflowY).toBe("auto");
      expect(metrics.listScrollable).toBe(true);
      expect(metrics.activeBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(metrics.dateWhiteSpace).toBe("nowrap");
      expect(metrics.dateHeight).toBeLessThan(24);
      expect(metrics.listTitleWhiteSpace).toBe("nowrap");
      expect(metrics.listTitleHeight).toBeLessThan(24);
      expect(metrics.detailTitleWritingMode).toBe("horizontal-tb");
      expect(metrics.detailTitleWidth).toBeGreaterThan(width <= 370 ? 240 : 300);
      expect(metrics.detailWidth).toBeGreaterThan(width <= 370 ? 260 : 350);
      expect(metrics.detailOverflowY).toBe(width <= 767 ? "visible" : "auto");
    });
  }

  for (const width of acceptanceWidths) {
    it(`${width}px 下详情正文行高、区块间距与中文换行符合断点要求`, async () => {
      await mountWorkspace(width);
      const metrics = await page.locator(".detailContent").evaluate(content => {
        const meta = content.querySelector<HTMLElement>(".detailMeta")!;
        const title = content.querySelector<HTMLElement>(".detailTitle")!;
        const divider = content.querySelector<HTMLElement>(".detailDivider")!;
        const body = content.querySelector<HTMLElement>(".detailBody")!;
        const first = body.querySelector<HTMLElement>(".longChinese")!;
        const second = first.nextElementSibling as HTMLElement;
        const readStatus = content.querySelector<HTMLElement>(".readStatus")!;
        const bodyStyle = getComputedStyle(body);
        const firstStyle = getComputedStyle(first);
        const contentBounds = content.getBoundingClientRect();
        const firstBounds = first.getBoundingClientRect();
        const secondBounds = second.getBoundingClientRect();
        return {
          metaMarginBottom: Number.parseFloat(getComputedStyle(meta).marginBottom),
          titleMarginBottom: Number.parseFloat(getComputedStyle(title).marginBottom),
          dividerMarginBottom: Number.parseFloat(getComputedStyle(divider).marginBottom),
          bodyLineHeight: Number.parseFloat(bodyStyle.lineHeight),
          paragraphMarginTop: Number.parseFloat(firstStyle.marginTop),
          paragraphMarginBottom: Number.parseFloat(firstStyle.marginBottom),
          readStatusMarginTop: Number.parseFloat(getComputedStyle(readStatus).marginTop),
          readStatusPaddingTop: Number.parseFloat(getComputedStyle(readStatus).paddingTop),
          firstLineCount: firstBounds.height / Number.parseFloat(firstStyle.lineHeight),
          firstBottom: firstBounds.bottom,
          secondTop: secondBounds.top,
          contentLeft: contentBounds.left,
          contentRight: contentBounds.right,
          firstLeft: firstBounds.left,
          firstRight: firstBounds.right,
          bodyScrollWidth: body.scrollWidth,
          bodyClientWidth: body.clientWidth,
        };
      });

      const narrow = width <= 767;
      expect(metrics.metaMarginBottom).toBeCloseTo(narrow ? 20 * 5 / 6 : 20, 1);
      expect(metrics.titleMarginBottom).toBeCloseTo(narrow ? 20 * 5 / 6 : 20, 1);
      expect(metrics.dividerMarginBottom).toBeCloseTo(narrow ? 22 * 5 / 6 : 22, 1);
      expect(metrics.bodyLineHeight).toBeCloseTo(16 * (narrow ? 1.75 * 7 / 8 : 1.75), 1);
      expect(metrics.paragraphMarginTop).toBeCloseTo(16 * (narrow ? 1.25 * 5 / 6 : 1.25), 1);
      expect(metrics.paragraphMarginBottom).toBeCloseTo(16 * (narrow ? 1.25 * 5 / 6 : 1.25), 1);
      expect(metrics.readStatusMarginTop).toBeCloseTo(narrow ? 32 * 5 / 6 : 32, 1);
      expect(metrics.readStatusPaddingTop).toBeCloseTo(narrow ? 20 * 5 / 6 : 20, 1);
      expect(metrics.firstLineCount).toBeGreaterThan(1.9);
      expect(metrics.secondTop).toBeGreaterThanOrEqual(metrics.firstBottom);
      expect(metrics.firstLeft).toBeGreaterThanOrEqual(metrics.contentLeft);
      expect(metrics.firstRight).toBeLessThanOrEqual(metrics.contentRight + 0.5);
      expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth);
      if (narrow) expect(metrics.firstLeft).toBeGreaterThanOrEqual(10);
    });
  }

  for (const width of acceptanceWidths) {
    it(`${width}px 下滚动到底仍停在底部导航上方`, async () => {
      await mountWorkspace(width);
      const metrics = await page.locator(".shellWorkspace").evaluate((workspace, mobile) => {
        const detail = document.querySelector<HTMLElement>(".detailPane")!;
        const scrollTarget = mobile ? workspace : detail;
        scrollTarget.scrollTop = scrollTarget.scrollHeight;
        const bottomNav = document.querySelector<HTMLElement>(".bottomNav")!;
        const end = document.querySelector<HTMLElement>(".detailEnd")!;
        const workspaceBounds = workspace.getBoundingClientRect();
        const detailBounds = detail.getBoundingClientRect();
        const navBounds = bottomNav.getBoundingClientRect();
        const endBounds = end.getBoundingClientRect();
        return {
          workspaceBottom: workspaceBounds.bottom,
          detailBottom: detailBounds.bottom,
          navTop: navBounds.top,
          endBottom: endBounds.bottom,
        };
      }, width <= 767);

      expect(metrics.workspaceBottom).toBeLessThanOrEqual(metrics.navTop + 0.5);
      expect(metrics.detailBottom).toBeLessThanOrEqual(metrics.navTop + 0.5);
      expect(metrics.endBottom).toBeLessThanOrEqual(Math.min(metrics.detailBottom, metrics.navTop) + 0.5);
    });
  }
});
