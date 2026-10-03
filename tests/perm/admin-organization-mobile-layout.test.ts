import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const organizationCss = readFileSync("components/admin/admin-organization.module.css", "utf8");
const sharedCss = readFileSync("components/ui/my-pages.module.css", "utf8");
const acceptanceWidths = [319, 385, 767, 768, 1200] as const;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function mountOrganization(width: number) {
  await page.setViewportSize({ width, height: 720 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; margin: 0; }
      :root {
        --paper: #f6f5f2;
        --surface: #fff;
        --surface-2: #eef0ed;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
        --stage: #8b5c43;
      }
      ${sharedCss}
      ${organizationCss}
    </style>
    <main class="workspace">
      <section class="panel" style="background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:22px;display:flex;flex-direction:column">
        <div class="desktopOnly" data-kind="desktop">
          <div class="splitLayout"><div>成员列表</div><div>成员详情</div></div>
        </div>
        <div class="mobileOnly mobileWorkspace" data-kind="mobile">
          <input class="mobileSearch" value="" aria-label="搜索成员">
          <button class="mobileListRow">
            <span style="width:34px;height:34px;flex-shrink:0"></span>
            <span class="mobileListCopy"><b>刘杰熙</b><small>乐手 · 作曲 · 制作人 · 制作助理</small></span>
            <span class="mobilePoc">★ POC</span><span class="mobileChevron">›</span>
          </button>
          <div class="detailTitleRow" style="display:flex;align-items:center;gap:10px">
            <input class="renameInput" value="这是一个较长的部门名称">
            <button>保存</button><button>取消</button>
          </div>
          <div class="deptMemberRow" style="display:flex;align-items:center;gap:9px">
            <span class="deptMemberName" style="flex:1">成员姓名很长也不能撑宽页面</span>
            <span>POC</span><button>取消 POC</button><button>移除</button>
          </div>
        </div>
      </section>
    </main>
  `);
}

describe("成员与部门真实浏览器断点", () => {
  for (const width of acceptanceWidths) {
    it(`${width}px 使用正确工作区且所有移动内容不横向溢出`, async () => {
      await mountOrganization(width);
      const metrics = await page.locator(".panel").evaluate(panel => {
        const mobile = panel.querySelector<HTMLElement>('[data-kind="mobile"]')!;
        const desktop = panel.querySelector<HTMLElement>('[data-kind="desktop"]')!;
        const panelBounds = panel.getBoundingClientRect();
        const rowBounds = panel.querySelector<HTMLElement>(".mobileListRow")!.getBoundingClientRect();
        const renameBounds = panel.querySelector<HTMLElement>(".renameInput")!.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          mobileDisplay: getComputedStyle(mobile).display,
          desktopDisplay: getComputedStyle(desktop).display,
          panelHeight: getComputedStyle(panel).height,
          panelMinHeight: getComputedStyle(panel).minHeight,
          panelPadding: getComputedStyle(panel).padding,
          panelBounds: { left: panelBounds.left, right: panelBounds.right },
          rowBounds: { left: rowBounds.left, right: rowBounds.right },
          renameBounds: { left: renameBounds.left, right: renameBounds.right },
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.panelBounds.left).toBeGreaterThanOrEqual(0);
      expect(metrics.panelBounds.right).toBeLessThanOrEqual(metrics.viewportWidth);
      if (width <= 767) {
        expect(metrics.mobileDisplay).toBe("block");
        expect(metrics.desktopDisplay).toBe("none");
        expect(metrics.panelMinHeight).toBe("0px");
        expect(metrics.panelPadding).toBe("14px");
        expect(metrics.rowBounds.left).toBeGreaterThanOrEqual(metrics.panelBounds.left);
        expect(metrics.rowBounds.right).toBeLessThanOrEqual(metrics.panelBounds.right);
        expect(metrics.renameBounds.left).toBeGreaterThanOrEqual(metrics.panelBounds.left);
        expect(metrics.renameBounds.right).toBeLessThanOrEqual(metrics.panelBounds.right);
      } else {
        expect(metrics.mobileDisplay).toBe("none");
        expect(metrics.desktopDisplay).toBe("block");
        expect(Number.parseFloat(metrics.panelHeight)).toBeGreaterThanOrEqual(460);
      }
    });
  }
});
