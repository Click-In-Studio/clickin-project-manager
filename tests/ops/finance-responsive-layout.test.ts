import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const financePage = readFileSync("app/production/[id]/finance/page.tsx", "utf8");
const responsiveCss = readFileSync("components/ops/responsive.module.css", "utf8");
const actionCss = readFileSync("components/ops/finance-expense-actions.module.css", "utf8");

function blockAfter(source: string, marker: string): string {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`找不到样式块：${marker}`);
  const openBrace = source.indexOf("{", markerStart + marker.length);
  if (openBrace < 0) throw new Error(`样式块缺少左花括号：${marker}`);

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openBrace + 1, index);
  }
  throw new Error(`样式块缺少右花括号：${marker}`);
}

describe("财务页响应式布局", () => {
  it("用语义 class 承载财务页、预算分类和支出行布局", () => {
    for (const className of [
      "financePage",
      "financeMetricGrid",
      "financeColumns",
      "financeColumnsTwoUp",
      "financePanel",
      "financeCategorySummary",
      "financeExpenseRow",
      "financeExpenseActions",
    ]) {
      expect(financePage).toContain(`responsive.${className}`);
    }
    expect(financePage).not.toContain('gridTemplateColumns: twoUp ?');
  });

  it("正文顺序始终先预算分类、后近期支出", () => {
    const categories = financePage.indexOf(">预算分类<");
    const expenses = financePage.indexOf('canAllExpenses ? "近期支出" : "我的报销"');
    expect(categories).toBeGreaterThan(-1);
    expect(expenses).toBeGreaterThan(categories);
  });

  it("桌面保持双列，700px 以下改为单列并让金额和操作换行", () => {
    const desktop = responsiveCss.slice(0, responsiveCss.indexOf("@media"));
    expect(desktop).toMatch(/\.financeColumnsTwoUp\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.15fr\) minmax\(300px, \.85fr\);/);
    expect(desktop).toMatch(/\.financeExpenseRow\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/);

    const narrow = blockAfter(responsiveCss, "@media (max-width: 700px)");
    expect(narrow).toMatch(/\.financeColumnsTwoUp\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(narrow).toMatch(/\.financeExpenseRow\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(narrow).toMatch(/\.financeExpenseActions\s*\{[^}]*flex-direction:\s*row;[^}]*flex-wrap:\s*wrap;/);
    expect(narrow).toMatch(/\.financeExpenseAmount\s*\{[^}]*flex:\s*1 1 100%;[^}]*text-align:\s*left;/);
  });

  it("手机汇总卡固定两列，分类金额在极窄屏纵向阅读", () => {
    const mobile = blockAfter(responsiveCss, "@media (max-width: 640px)");
    expect(mobile).toMatch(/\.metricGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(mobile).toMatch(/\.financePage\s*\{[^}]*padding:\s*20px 14px 80px;/);
    expect(mobile).toMatch(/\.financeMetricValue\s*\{[^}]*font-size:\s*clamp\(16px, 5\.2vw, 20px\);/);

    const veryNarrow = blockAfter(responsiveCss, "@media (max-width: 480px)");
    expect(veryNarrow).toMatch(/\.financeCategorySummary\s*\{[^}]*flex-direction:\s*column;/);
    expect(veryNarrow).toMatch(/\.financeCategoryAmount\s*\{[^}]*text-align:\s*left;/);
  });

  it("手机审批、详情和凭证操作可换行且保持完整宽度", () => {
    const mobileActions = blockAfter(actionCss, "@media (max-width: 640px)");
    expect(mobileActions).toMatch(/\.approvalActions\s*\{[^}]*width:\s*100%;[^}]*align-items:\s*stretch;/);
    expect(mobileActions).toMatch(/\.actionButtons,[\s\S]*?\.rejectConfirm\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(mobileActions).toMatch(/\.actionButtons input,[\s\S]*?\.rejectConfirm textarea\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/);
    expect(mobileActions).toMatch(/\.documentLinks span\s*\{[^}]*flex-wrap:\s*wrap;/);
  });
});
