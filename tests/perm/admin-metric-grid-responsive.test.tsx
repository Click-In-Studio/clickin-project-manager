import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import AdminMetricGrid from "@/components/admin/AdminMetricGrid";

const css = readFileSync("components/admin/admin-metric-grid.module.css", "utf8");
const acceptanceWidths = [319, 468, 651, 768, 1200] as const;

const consumers = [
  ["app/production/[id]/admin/page.tsx", 5, 'responsive="overview"'],
  ["components/admin/AdminAnnouncementsClient.tsx", 3, 'responsive="compactThree"'],
  ["components/admin/AdminOrganizationClient.tsx", 4, 'responsive="seatPriority"'],
  ["components/admin/AdminRolesClient.tsx", 3, 'responsive="compactThree"'],
  ["components/admin/AdminPermissionCenterClient.tsx", 4, 'responsive="permission"'],
  ["components/admin/AdminTemplatesClient.tsx", 3, 'responsive="allOrStacked"'],
  ["components/admin/AdminPoliciesClient.tsx", 3, null],
  ["components/admin/AdminAuditClient.tsx", 3, null],
  ["components/admin/AdminAssetReviewClient.tsx", 3, null],
] as const;

let browser: Browser;
let page: Page;

type Responsive = "overview" | "standard" | "permission" | "compactThree" | "seatPriority" | "allOrStacked";

function itemsFor(variant: Responsive, columns: number) {
  if (variant === "compactThree") {
    return [
      ["1000", "角色", "含系统角色"],
      ["1000", "已指派成员", "共 1000 名成员"],
      ["1000", "未指派", "无角色成员"],
    ];
  }
  if (variant === "seatPriority") {
    return [
      ["1000 / 1000", "项目成员", "全部在职"],
      ["12", "部门", "组织架构"],
      ["6", "用户组", "仅供选人"],
      ["8", "POC", "部门联络人次"],
    ];
  }
  return Array.from({ length: columns }, (_, index) => [
    index === 0 ? "128 / 200" : String(index + 1),
    index === 0 ? "类型配了审批人" : "项目成员",
    index === 0 ? "未配则落制作人 → 所有者" : "包含不在职成员",
  ]);
}

async function mountGrid(width: number, variant: Responsive, columns: number) {
  const items = itemsFor(variant, columns);
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
        ${items.map(([value, label, hint]) => `
          <div class="card">
            <span class="value">${value}</span>
            <p class="copy">
              <b class="label">${label}</b>
              <small class="hint">${hint}</small>
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

  it("九个目标页面只通过 admin 共享组件声明各自指标与布局策略", () => {
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
    ["compactThree", 3, [3, 3, 3, 3, 3]],
    ["seatPriority", 4, [3, 3, 3, 3, 4]],
    ["allOrStacked", 3, [1, 1, 1, 1, 3]],
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
            cardHeight: cards[0].getBoundingClientRect().height,
            gridBounds: { left: gridBounds.left, right: gridBounds.right },
            cards: cards.map(card => {
              const bounds = card.getBoundingClientRect();
              const value = card.querySelector<HTMLElement>(".value")!;
              const label = card.querySelector<HTMLElement>(".label")!;
              const hint = card.querySelector<HTMLElement>(".hint")!;
              return {
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                width: bounds.width,
                valueWhiteSpace: getComputedStyle(value).whiteSpace,
                labelWhiteSpace: getComputedStyle(label).whiteSpace,
                hintWhiteSpace: getComputedStyle(hint).whiteSpace,
                valueFits: value.scrollWidth <= value.clientWidth,
                labelFits: label.scrollWidth <= label.clientWidth,
                hintFits: hint.scrollWidth <= hint.clientWidth,
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
        if (variant === "compactThree") {
          for (const card of metrics.cards) {
            expect(card.valueFits).toBe(true);
            expect(card.labelFits).toBe(true);
            expect(card.hintFits).toBe(true);
          }
          if (width <= 480) expect(metrics.cardHeight).toBeLessThanOrEqual(77);
        }
        if (variant === "seatPriority") {
          expect(metrics.cards[0].valueFits).toBe(true);
          expect(metrics.cards[0].labelFits).toBe(true);
          expect(metrics.cards[0].hintFits).toBe(true);
        }
        if (variant === "seatPriority" && width <= 768) {
          const [, ...secondaryCards] = metrics.cards;
          expect(secondaryCards.every(card => card.top > metrics.cards[0].top)).toBe(true);
          expect(new Set(secondaryCards.map(card => Math.round(card.top))).size).toBe(1);
          expect(new Set(secondaryCards.map(card => Math.round(card.width))).size).toBe(1);
        }
        if (variant === "allOrStacked") expect(metrics.columns).not.toBe(2);
      });
    }
  }

  for (const width of [319, 651]) {
    it(`公告与角色的紧凑三列在 ${width}px 放大标签和提示`, async () => {
      await mountGrid(width, "compactThree", 3);
      const typography = await page.locator(".card").first().evaluate(card => ({
        label: getComputedStyle(card.querySelector<HTMLElement>(".label")!).fontSize,
        hint: getComputedStyle(card.querySelector<HTMLElement>(".hint")!).fontSize,
      }));

      expect(typography).toEqual({ label: "12px", hint: "10px" });
    });
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
