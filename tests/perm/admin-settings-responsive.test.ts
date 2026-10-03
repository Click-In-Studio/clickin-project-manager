import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const component = readFileSync("components/admin/AdminSettingsClient.tsx", "utf8");
const css = readFileSync("components/admin/admin-settings.module.css", "utf8");
const acceptanceWidths = [319, 375, 453, 768, 1280] as const;

let browser: Browser;
let page: Page;

async function mountBasicInfo(width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --paper: #f6f5f1;
        --surface: #f2f3f2;
        --line: #d7dcda;
        --ink: #172523;
        --muted: #66736f;
      }
      ${css}
      .fixtureInput {
        min-width: 0;
        flex: 1;
        padding: 7px 11px;
        border: 1px solid var(--line);
        border-radius: 8px;
        font-size: 13px;
      }
      .fixtureButton {
        flex-shrink: 0;
        padding: 7px 14px;
        border: 0;
        border-radius: 7px;
        font-size: 12px;
        white-space: nowrap;
      }
    </style>
    <main class="pageContent">
      <section class="card basicInfoCard">
        <header class="cardHeader">基本信息</header>
        <div class="settingRow basicInfoRow">
          <div class="rowLabel"><strong>项目名称</strong><p>显示于项目列表、配置中心标题栏</p></div>
          <div class="rowContent">
            <div class="basicInfoInlineField">
              <input class="fixtureInput basicInfoInput" value="一个很长的项目名称用于检查窄屏布局" />
              <button class="fixtureButton basicInfoButton">保存</button>
            </div>
          </div>
        </div>
        <div class="settingRow basicInfoRow">
          <div class="rowLabel"><strong>项目头像</strong><p>展示于项目列表和顶栏，JPG / PNG / WebP，最大 5 MB</p></div>
          <div class="rowContent">
            <div class="avatarField">
              <div style="width:56px;height:56px;flex-shrink:0"></div>
              <div class="avatarControls"><button class="fixtureButton basicInfoButton avatarButton">更换头像</button></div>
            </div>
          </div>
        </div>
        <div class="settingRow basicInfoRow">
          <div class="rowLabel"><strong>项目简介</strong><p>在项目首页展示，简短介绍背景或特色</p></div>
          <div class="rowContent">
            <textarea class="fixtureInput basicInfoInput">项目简介</textarea>
            <div class="basicInfoSaveRow"><button class="fixtureButton basicInfoButton">保存</button></div>
          </div>
        </div>
        <div class="settingRow basicInfoRow">
          <div class="rowLabel"><strong>项目类型</strong><p>未来将绑定模版与导航别称</p></div>
          <div class="rowContent">
            <div class="typeControls">
              <button role="combobox" class="fixtureInput basicInfoSelect">其他</button>
              <input class="fixtureInput basicInfoInput" value="自定义类型名称" />
              <button class="fixtureButton basicInfoButton">保存</button>
            </div>
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

describe("项目信息基本资料响应式布局", () => {
  it("响应式样式只挂到基本信息行，保存与权限逻辑仍由原组件负责", () => {
    expect(component).toContain('<Card title="基本信息" basicInfo>');
    expect(component.match(/<Row[^>]*mobileStack/g)?.length).toBe(5);
    expect(component).toContain("!perms.canRename");
    expect(component).toContain("!perms.canChangeAvatar");
    expect(component).toContain("!perms.canEditDescription");
    expect(component).toContain("!perms.canChangeType");
    expect(component).toContain("nameSave.save({ name: name.trim() })");
    expect(component).toContain("typeSave.save({ type: type || null");
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下控件完整留在基本信息卡内`, async () => {
      await mountBasicInfo(width);
      const metrics = await page.locator(".basicInfoCard").evaluate((card, viewportWidth) => {
        const rows = [...card.querySelectorAll<HTMLElement>(".basicInfoRow")];
        const controls = [...card.querySelectorAll<HTMLElement>("input, textarea, button")];
        const firstRowStyle = getComputedStyle(rows[0]);
        const controlBounds = controls.map((control) => {
          const bounds = control.getBoundingClientRect();
          const rowBounds = control.closest<HTMLElement>(".basicInfoRow")!.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            rowLeft: rowBounds.left,
            rowRight: rowBounds.right,
            fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
          };
        });
        return {
          viewportWidth,
          documentWidth: document.documentElement.scrollWidth,
          rowDisplay: firstRowStyle.display,
          rowColumns: firstRowStyle.gridTemplateColumns,
          controlBounds,
        };
      }, width);

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.rowDisplay).toBe(width <= 600 ? "block" : "grid");
      if (width > 600) expect(metrics.rowColumns).toMatch(/^220px /);
      for (const control of metrics.controlBounds) {
        expect(control.left).toBeGreaterThanOrEqual(control.rowLeft - 0.5);
        expect(control.right).toBeLessThanOrEqual(control.rowRight + 0.5);
        if (width <= 600) expect(control.fontSize).toBeGreaterThanOrEqual(16);
      }
    });
  }

  for (const width of [319, 375, 453] as const) {
    it(`${width}px 下名称、简介和类型的保存按钮占满可用宽度`, async () => {
      await mountBasicInfo(width);
      const widths = await page.locator(".basicInfoRow").evaluateAll((rows) => rows
        .filter((_, index) => index !== 1)
        .map((row) => {
          const content = row.querySelector<HTMLElement>(".rowContent")!.getBoundingClientRect();
          const button = row.querySelector<HTMLButtonElement>(".basicInfoButton")!.getBoundingClientRect();
          return { content: content.width, button: button.width };
        }));
      for (const measured of widths) expect(measured.button).toBeCloseTo(measured.content, 0);
    });
  }
});
