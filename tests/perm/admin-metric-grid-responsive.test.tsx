import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import AdminMetricGrid from "@/components/admin/AdminMetricGrid";

const css = readFileSync("components/admin/admin-metric-grid.module.css", "utf8");
const acceptanceWidths = [319, 385, 580, 768, 1200] as const;

const consumers = [
  ["app/production/[id]/admin/page.tsx", 5, 'responsive="overview"'],
  ["components/admin/AdminOrganizationClient.tsx", 4, null],
  ["components/admin/AdminRolesClient.tsx", 3, null],
  ["components/admin/AdminPermissionCenterClient.tsx", 4, 'responsive="permission"'],
  ["components/admin/AdminTemplatesClient.tsx", 3, null],
  ["components/admin/AdminPoliciesClient.tsx", 3, null],
  ["components/admin/AdminAuditClient.tsx", 3, null],
  ["components/admin/AdminAssetReviewClient.tsx", 3, null],
] as const;

let browser: Browser;
let page: Page;

async function mountGrid(width: number, variant: "overview" | "standard" | "permission", columns: number) {
  await page.setViewportSize({ width, height: 720 });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; }
      :root {
        --surface: #fff;
        --surface-2: #eef0ef;
        --line: #ccd4d1;
        --ink: #172523;
        --muted: #66736f;
      }
      ${css}
    </style>
    <main style="padding: 24px 18px 60px">
      <div class="grid ${variant}" style="--admin-metric-columns: ${columns}">
        ${Array.from({ length: columns }, (_, index) => `
          <div class="card">
            <span class="value">${index === 0 ? "128 / 200" : index + 1}</span>
            <p class="copy">
              <b class="label">${index === 0 ? "类型配了审批人" : "项目成员"}</b>
              <small class="hint">${index === 0 ? "未配则落制作人 → 所有者" : "包含不在职成员"}</small>
            </p>
          </div>
        `).join("")}
      </div>
      <div class="policyTabs">
        <button class="policyTab">常用设置</button>
        <button class="policyTab">高级（逐项）</button>
        <button class="policyTab">改动记录</button>
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

describe("admin 摘要指标共享组件", () => {
  it("渲染数字、标题、说明和可选说明色", () => {
    const html = renderToStaticMarkup(
      <AdminMetricGrid
        columns={3}
        items={[
          { value: "12", label: "角色", hint: "含系统角色" },
          { value: "3", label: "未指派", hint: "无角色成员", hintColor: "rgb(168, 50, 50)" },
        ]}
      />,
    );

    expect(html).toContain('data-admin-metric-grid="standard"');
    expect(html).toContain("--admin-metric-columns:3");
    expect(html).toContain("含系统角色");
    expect(html).toContain("rgb(168, 50, 50)");
  });

  it("八个目标页面只通过 admin 共享组件声明各自指标", () => {
    for (const [path, columns, responsive] of consumers) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("<AdminMetricGrid");
      expect(source, path).toContain(`columns={${columns}}`);
      if (responsive) expect(source, path).toContain(responsive);
      expect(source, path).not.toMatch(/gridTemplateColumns:\s*"repeat\([345], 1fr\)"/);
    }
  });

  it("策略页签使用可收缩的 admin 专用导航样式", () => {
    const source = readFileSync("components/admin/AdminPoliciesClient.tsx", "utf8");
    expect(source).toContain("metricStyles.policyTabs");
    expect(source.match(/metricStyles\.policyTab\b/g)).toHaveLength(3);
    expect(source).not.toContain("width: 360");
  });
});

describe("admin 摘要指标真实浏览器布局", () => {
  const scenarios = [
    ["overview", 5, [2, 2, 2, 2, 5]],
    ["standard", 3, [1, 1, 2, 2, 3]],
    ["permission", 4, [1, 1, 2, 2, 4]],
  ] as const;

  for (const [variant, columns, expectedColumns] of scenarios) {
    for (const [index, width] of acceptanceWidths.entries()) {
      it(`${variant} 在 ${width}px 下使用 ${expectedColumns[index]} 栏且内容不横向溢出`, async () => {
        await mountGrid(width, variant, columns);
        const metrics = await page.locator(".grid").evaluate((grid) => {
          const cards = [...grid.querySelectorAll<HTMLElement>(".card")];
          const gridBounds = grid.getBoundingClientRect();
          return {
            columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            cardPaddingTop: getComputedStyle(cards[0]).paddingTop,
            gridBounds: { left: gridBounds.left, right: gridBounds.right },
            cards: cards.map(card => {
              const bounds = card.getBoundingClientRect();
              const value = card.querySelector<HTMLElement>(".value")!;
              const label = card.querySelector<HTMLElement>(".label")!;
              const hint = card.querySelector<HTMLElement>(".hint")!;
              return {
                left: bounds.left,
                right: bounds.right,
                valueWhiteSpace: getComputedStyle(value).whiteSpace,
                labelWhiteSpace: getComputedStyle(label).whiteSpace,
                hintWhiteSpace: getComputedStyle(hint).whiteSpace,
              };
            }),
          };
        });

        expect(metrics.columns).toBe(expectedColumns[index]);
        expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.gridBounds.left).toBeGreaterThanOrEqual(0);
        expect(metrics.gridBounds.right).toBeLessThanOrEqual(metrics.viewportWidth);
        for (const card of metrics.cards) {
          expect(card.left).toBeGreaterThanOrEqual(metrics.gridBounds.left - 0.5);
          expect(card.right).toBeLessThanOrEqual(metrics.gridBounds.right + 0.5);
          expect(card.valueWhiteSpace).toBe("nowrap");
          expect(card.labelWhiteSpace).toBe("nowrap");
          expect(card.hintWhiteSpace).toBe("nowrap");
        }
        if (variant === "overview" && width <= 480) expect(metrics.cardPaddingTop).toBe("10px");
      });
    }
  }

  for (const width of acceptanceWidths) {
    it(`策略导航在 ${width}px 下不溢出`, async () => {
      await mountGrid(width, "standard", 3);
      const metrics = await page.locator(".policyTabs").evaluate(nav => {
        const bounds = nav.getBoundingClientRect();
        const firstButton = nav.querySelector<HTMLElement>(".policyTab")!;
        return {
          right: bounds.right,
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          paddingInline: getComputedStyle(nav).paddingInline,
          buttonPaddingInline: getComputedStyle(firstButton).paddingInline,
        };
      });

      expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      if (width <= 480) {
        expect(metrics.paddingInline).toBe("2px");
        expect(metrics.buttonPaddingInline).toBe("4px");
      }
    });
  }
});
