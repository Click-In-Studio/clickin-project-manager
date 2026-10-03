import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const bulkInvite = readFileSync("components/admin/BulkInviteCard.tsx", "utf8");
const settingsClient = readFileSync("components/admin/AdminSettingsClient.tsx", "utf8");
const migrationPage = readFileSync("app/production/[id]/admin/migration/page.tsx", "utf8");
const css = readFileSync("components/admin/admin-migration.module.css", "utf8");
const acceptanceWidths = [319, 371, 768, 1180] as const;

let browser: Browser;
let page: Page;

async function mountMigrationPage(width: number, height = 760) {
  await page.setViewportSize({ width, height });
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
      }
      ${css}
    </style>
    <main class="page">
      <h1>数据迁移</h1>
      <section class="inviteCard">
        <div class="modeSwitch"><button>飞书表格</button><button>粘贴邮箱</button></div>
        <p>粘贴飞书多维表格 Wiki 链接</p>
        <div class="sheetUrlRow">
          <input class="sheetUrlInput" value="https://example.feishu.cn/wiki/example" />
          <button class="sheetParseButton">识别表格</button>
        </div>
        <textarea class="emailTextarea">alice@example.com</textarea>
      </section>
      <section class="dataCard">
        <div class="dataRow">
          <div class="dataLabel"><p class="dataTitle">导入数据</p><p class="dataHint">跳转至专属导入页面</p></div>
          <div class="importList">
            <div class="importItem">
              <div class="importCopy"><p class="importTitle">导入剧本</p><p class="importDescription">从飞书表格导入台词、角色、场景号</p></div>
              <a class="importLink" href="#script">前往 →</a>
            </div>
            <div class="importItem">
              <div class="importCopy"><p class="importTitle">导入构作</p><p class="importDescription">从飞书表格导入场次、梗概、时长</p></div>
              <a class="importLink" href="#dramaturgy">前往 →</a>
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

describe("数据迁移页响应式布局", () => {
  it("保留识别、批量邀请和导入跳转的原有业务接线", () => {
    expect(bulkInvite).toContain("onClick={parseSheet}");
    expect(bulkInvite).toContain("/invites/parse-table");
    expect(bulkInvite).toContain("/invites/table-send");
    expect(bulkInvite).toContain("onClick={send}");
    expect(settingsClient).toContain("/import-script");
    expect(settingsClient).toContain("/import-scenes");
  });

  it("真实页面与组件逐项接入浏览器验收所覆盖的响应式 class", () => {
    expect(migrationPage).toContain("className={styles.page}");
    for (const className of [
      "inviteCard",
      "modeSwitch",
      "sheetUrlRow",
      "sheetUrlInput",
      "sheetParseButton",
      "emailTextarea",
    ]) {
      expect(bulkInvite).toContain(`styles.${className}`);
    }
    for (const className of [
      "dataRow",
      "dataLabel",
      "importList",
      "importItem",
      "importCopy",
      "importLink",
    ]) {
      expect(settingsClient).toContain(`migrationStyles.${className}`);
    }
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下识别区和两个导入入口完整位于页面内`, async () => {
      await mountMigrationPage(width);
      const metrics = await page.locator(".page").evaluate((root) => {
        const bounds = (selector: string) => root.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        const input = root.querySelector<HTMLInputElement>(".sheetUrlInput")!;
        const textarea = root.querySelector<HTMLTextAreaElement>(".emailTextarea")!;
        const parseButton = bounds(".sheetParseButton");
        const inputBounds = input.getBoundingClientRect();
        const inviteBounds = bounds(".inviteCard");
        const importItems = [...root.querySelectorAll<HTMLElement>(".importItem")].map(item => item.getBoundingClientRect());
        const importLinks = [...root.querySelectorAll<HTMLElement>(".importLink")].map(link => link.getBoundingClientRect());
        const inputStyle = getComputedStyle(input);
        const textareaStyle = getComputedStyle(textarea);
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          inputLeft: inputBounds.left,
          inputRight: inputBounds.right,
          inputBottom: inputBounds.bottom,
          inputFontSize: Number.parseFloat(inputStyle.fontSize),
          inputPaddingTop: Number.parseFloat(inputStyle.paddingTop),
          textareaFontSize: Number.parseFloat(textareaStyle.fontSize),
          textareaPaddingTop: Number.parseFloat(textareaStyle.paddingTop),
          parseLeft: parseButton.left,
          parseRight: parseButton.right,
          parseTop: parseButton.top,
          inviteLeft: inviteBounds.left,
          inviteRight: inviteBounds.right,
          dataColumns: getComputedStyle(root.querySelector<HTMLElement>(".dataRow")!).gridTemplateColumns.split(" ").length,
          importItems: importItems.map(item => ({ left: item.left, right: item.right })),
          importLinks: importLinks.map(link => ({ left: link.left, right: link.right, width: link.width })),
          importDirection: getComputedStyle(root.querySelector<HTMLElement>(".importItem")!).flexDirection,
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.inputLeft).toBeGreaterThanOrEqual(metrics.inviteLeft);
      expect(metrics.inputRight).toBeLessThanOrEqual(metrics.inviteRight);
      expect(metrics.parseLeft).toBeGreaterThanOrEqual(metrics.inviteLeft);
      expect(metrics.parseRight).toBeLessThanOrEqual(metrics.inviteRight);
      for (const item of metrics.importItems) {
        expect(item.left).toBeGreaterThanOrEqual(0);
        expect(item.right).toBeLessThanOrEqual(metrics.viewportWidth);
      }
      for (const link of metrics.importLinks) {
        expect(link.left).toBeGreaterThanOrEqual(0);
        expect(link.right).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(link.width).toBeGreaterThan(0);
      }

      if (width <= 640) {
        expect(metrics.parseTop).toBeGreaterThanOrEqual(metrics.inputBottom);
        expect(metrics.inputFontSize).toBeGreaterThanOrEqual(16);
        expect(metrics.textareaFontSize).toBeGreaterThanOrEqual(16);
        expect(metrics.inputPaddingTop).toBe(7.5);
        expect(metrics.textareaPaddingTop).toBe(8.5);
        expect(metrics.dataColumns).toBe(1);
      } else {
        expect(metrics.inputFontSize).toBe(13);
        expect(metrics.inputPaddingTop).toBe(9);
        expect(metrics.dataColumns).toBe(2);
      }

      if (width <= 480) {
        expect(metrics.importDirection).toBe("column");
        expect(metrics.importLinks.every(link => link.width > 180)).toBe(true);
      } else {
        expect(metrics.importDirection).toBe("row");
      }
    });
  }

  it("319px 下键盘压缩可视高度后仍能滚动到导入入口并点击", async () => {
    await mountMigrationPage(319, 360);
    await page.locator(".sheetUrlInput").focus();
    const lastLink = page.locator('.importLink[href="#dramaturgy"]');
    await lastLink.scrollIntoViewIfNeeded();
    const reachable = await lastLink.evaluate((link) => {
      const bounds = link.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      return {
        activeIsInput: document.activeElement?.classList.contains("sheetUrlInput") ?? false,
        top: bounds.top,
        bottom: bounds.bottom,
        viewportHeight: window.innerHeight,
        hitTarget: document.elementFromPoint(x, y) === link,
      };
    });

    expect(reachable.activeIsInput).toBe(true);
    expect(reachable.top).toBeGreaterThanOrEqual(0);
    expect(reachable.bottom).toBeLessThanOrEqual(reachable.viewportHeight);
    expect(reachable.hitTarget).toBe(true);
  });
});
