import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("components/ui/my-pages.module.css", "utf8");
const accessRequests = readFileSync("components/approval/AccessRequestsClient.tsx", "utf8");
const flowDesigner = readFileSync("components/approval/ApprovalFlowDesigner.tsx", "utf8");
const tasks = readFileSync("components/ops/ProductionTasksClient.tsx", "utf8");
const reports = readFileSync("components/ops/ProductionReportsClient.tsx", "utf8");

describe("移动内容面板响应式契约", () => {
  it("三个业务面板共用可被移动断点覆盖的高度类，不再把视口高度写进行内样式", () => {
    for (const source of [accessRequests, tasks, reports]) {
      expect(source).toContain("styles.responsiveContentPanel");
      expect(source).not.toContain('height: "calc(100vh - 320px)"');
      expect(source).not.toContain("minHeight: 460");
    }

    expect(css).toContain(".responsiveContentPanel {");
    expect(css).toContain("height: calc(100vh - 320px);");
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.responsiveContentPanel,[\s\S]*?height: auto;[\s\S]*?min-height: 0;[\s\S]*?overflow: visible;/);
  });

  it.each([
    [390, 844],
    [464, 781],
    [555, 781],
  ])("%d×%d 归入自然高度的手机布局", (width) => {
    expect(width).toBeLessThanOrEqual(767);
  });

  it.each([
    [768, 1024],
    [1440, 900],
  ])("%d×%d 保留桌面固定工作区和内部滚动", (width) => {
    expect(width).toBeGreaterThanOrEqual(768);
    expect(css).toContain(".reportWorkspaceGrid {");
    expect(css).toContain("height: 100%;");
    expect(tasks).toContain('style={{ overflowY: "auto"');
  });

  it("报告的 768–1180 卡片布局在固定面板内独立滚动", () => {
    expect(css).toMatch(/@media \(min-width: 768px\) and \(max-width: 1180px\)[\s\S]*?\.reportMobile \{[\s\S]*?min-height: 0;[\s\S]*?flex: 1;[\s\S]*?overflow-y: auto;/);
  });

  it("手机底部留出导航与安全区，流程空态可正常换行", () => {
    expect(css).toContain("calc(80px + env(safe-area-inset-bottom))");
    expect(css).toContain("calc(24px + env(safe-area-inset-bottom))");
    expect(flowDesigner).toContain("styles.approvalTemplateEmpty");
    expect(css).toMatch(/\.approvalDesignerGrid \{ display: flex; min-height: 0; flex: none;/);
    expect(css).toMatch(/\.approvalTemplateEmpty \{[\s\S]*?font-size: 13px;[\s\S]*?line-height: 1\.7;[\s\S]*?overflow-wrap: anywhere;/);
  });

  it("报告移动卡片单独收紧标题、正文、列表和提示框密度", () => {
    expect(reports).toContain("className={styles.mobileReportMarkdown}");
    for (const selector of [":global(h1)", ":global(h2)", ":global(p)", ":global(ul)", ":global(ol)", ":global(li)", ":global(.wiki-callout)"]) {
      expect(css).toContain(`.mobileReportMarkdown ${selector}`);
    }
  });
});
