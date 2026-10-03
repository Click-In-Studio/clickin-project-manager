import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

const component = readFileSync("components/admin/AdminAssetReviewClient.tsx", "utf8");
const css = readFileSync("components/admin/admin-asset-review.module.css", "utf8");
const acceptanceWidths = [319, 396, 441, 768, 1180] as const;

let browser: Browser;
let page: Page;

async function mountAssetRow(width: number) {
  await page.setViewportSize({ width, height: 760 });
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
        --script-soft: #eeeaf8;
        --script: #5c527f;
        --stage-soft: #f2e4d9;
        --stage: #8d572f;
        --danger: #a83232;
      }
      body { background: var(--paper); }
      .page { padding: 24px clamp(18px, 3vw, 52px) 60px; }
      .assetList { padding: 6px 22px 22px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
      .badge {
        display: inline-flex;
        align-items: center;
        width: fit-content;
        min-height: 22px;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--surface-2);
        color: var(--muted);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: .04em;
      }
      .action { padding: 4px 10px; border: 1px solid var(--ink); border-radius: 8px; background: transparent; white-space: nowrap; }
      ${css}
    </style>
    <main class="page">
      <section class="assetList">
        <div class="assetRow">
          <button class="assetToggle" aria-expanded="true">▾</button>
          <div class="assetDetails">
            <p class="assetName">第三幕技术合成与全体演员联合走台确认用的最终版舞台机械安全评估报告</p>
            <p class="fileMeta">stage-machinery-safety-assessment-final-version.pdf · 上传：亚历山大·汉密尔顿 · 2026/10/3</p>
          </div>
          <div class="assetActions">
            <div class="assetTypeRow badgeCell"><span class="badge">PDF 文档</span></div>
            <div class="assetCountRow">
              <span class="badgeCell"><span class="badge">挂载 12</span></span>
              <span class="badgeCell"><span class="badge">授权 8</span></span>
            </div>
            <div class="publicActionRow"><button class="action">设为公开</button></div>
          </div>
        </div>
        <div class="grantList">
          <div class="grantRow">
            <span class="grantName">亚历山大·汉密尔顿</span>
            <code class="grantCode">publication@view</code>
            <span class="badgeCell"><span class="badge">直接授予</span></span>
            <button class="action revokeButton">撤销</button>
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

describe("数字资产审查响应式行", () => {
  it("只重排行展示，保留文件信息和既有写动作", () => {
    expect(component).toContain("{a.name || a.fileName}");
    expect(component).toContain("{a.fileName} · 上传：{a.uploaderName || a.uploaderId.slice(0, 8)} · {fmtDate(a.createdAt)}");
    expect(component).toContain('post({ action: "set_public", assetId: a.id })');
    expect(component).toContain('post({ action: "revoke_grant", grantId })');
    expect(component).toContain("{canEdit && (");
    expect(component).not.toContain('textOverflow: "ellipsis"');
    expect(component).not.toContain('whiteSpace: "nowrap"');
  });

  for (const width of acceptanceWidths) {
    it(`${width}px 下名称、文件信息和所有角标完整且页面不横向溢出`, async () => {
      await mountAssetRow(width);
      const metrics = await page.locator(".assetRow").evaluate(row => {
        const name = row.querySelector<HTMLElement>(".assetName")!;
        const meta = row.querySelector<HTMLElement>(".fileMeta")!;
        const badges = [...document.querySelectorAll<HTMLElement>(".badge")];
        const rowBounds = row.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          rowLeft: rowBounds.left,
          rowRight: rowBounds.right,
          name: name.textContent,
          nameWhiteSpace: getComputedStyle(name).whiteSpace,
          nameTextOverflow: getComputedStyle(name).textOverflow,
          nameFits: name.scrollWidth <= name.clientWidth && name.scrollHeight <= name.clientHeight,
          meta: meta.textContent,
          metaFits: meta.scrollWidth <= meta.clientWidth && meta.scrollHeight <= meta.clientHeight,
          badges: badges.map(badge => ({
            text: badge.textContent,
            whiteSpace: getComputedStyle(badge).whiteSpace,
            fits: badge.scrollWidth <= badge.clientWidth,
          })),
        };
      });

      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.rowLeft).toBeGreaterThanOrEqual(0);
      expect(metrics.rowRight).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.name).toBe("第三幕技术合成与全体演员联合走台确认用的最终版舞台机械安全评估报告");
      expect(metrics.nameWhiteSpace).toBe("normal");
      expect(metrics.nameTextOverflow).toBe("clip");
      expect(metrics.nameFits).toBe(true);
      expect(metrics.meta).toContain("stage-machinery-safety-assessment-final-version.pdf");
      expect(metrics.meta).toContain("上传：亚历山大·汉密尔顿");
      expect(metrics.meta).toContain("2026/10/3");
      expect(metrics.metaFits).toBe(true);
      expect(metrics.badges.map(badge => badge.text)).toEqual(["PDF 文档", "挂载 12", "授权 8", "直接授予"]);
      expect(metrics.badges.every(badge => badge.whiteSpace === "nowrap" && badge.fits)).toBe(true);
    });
  }

  for (const width of acceptanceWidths.slice(0, 3)) {
    it(`${width}px 窄屏按类型、挂载授权、公开动作三行排列`, async () => {
      await mountAssetRow(width);
      const positions = await page.locator(".assetActions").evaluate(actions => {
        const bounds = (selector: string) => actions.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        const type = bounds(".assetTypeRow");
        const counts = bounds(".assetCountRow");
        const mount = bounds(".assetCountRow .badgeCell:first-child");
        const grant = bounds(".assetCountRow .badgeCell:last-child");
        const publish = bounds(".publicActionRow");
        return { type, counts, mount, grant, publish };
      });

      expect(positions.type.bottom).toBeLessThanOrEqual(positions.counts.top);
      expect(Math.abs(positions.mount.top - positions.grant.top)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(positions.mount.bottom - positions.grant.bottom)).toBeLessThanOrEqual(0.5);
      expect(positions.counts.bottom).toBeLessThanOrEqual(positions.publish.top);
    });
  }

  for (const width of acceptanceWidths.slice(3)) {
    it(`${width}px 平板和桌面保留紧凑横排行`, async () => {
      await mountAssetRow(width);
      const centers = await page.locator(".assetActions").evaluate(actions =>
        [".assetTypeRow", ".assetCountRow", ".publicActionRow"].map(selector => {
          const bounds = actions.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return (bounds.top + bounds.bottom) / 2;
        }),
      );
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(0.5);
    });
  }
});
