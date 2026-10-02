import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("components/approval/ApprovalCenterClient.tsx", "utf8");
const styles = readFileSync("components/ui/my-pages.module.css", "utf8");

describe("项目审批中心客户端契约", () => {
  it("关系主视图与业务类型筛选正交，默认由项目级资源提供数据", () => {
    for (const label of ["待我处理", "我已处理", "抄送我的", "我的申请"]) {
      expect(source).toContain(`label: "${label}"`);
    }
    for (const label of ["全部", "权限申请", "费用报销"]) {
      expect(source).toContain(`label: "${label}"`);
    }
    expect(source).toContain("/approval-items?");
    expect(source).not.toContain("/api/my/approval-center");
  });

  it("列表只负责定位，权限与费用分别重新加载业务详情", () => {
    expect(source).toContain("/access-requests/${selected.item.sourceId}/flow");
    expect(source).toContain("/finance/expenses/${selected.item.sourceId}");
    expect(source).toContain("<RequestDetail");
    expect(source).toContain("<ExpenseDetail");
  });

  it("旧跨项目路由已经删除，流程模版不再挂在审批中心", () => {
    expect(existsSync("app/api/my/approval-center/route.ts")).toBe(false);
    expect(source).not.toContain("ApprovalFlowDesigner");
    expect(existsSync("app/production/[id]/admin/approval-flows/page.tsx")).toBe(true);
  });

  it("列表、筛选、手机元信息和费用详情使用统一字号层级", () => {
    for (const className of [
      "approvalCenterSummary", "approvalCenterFilters", "approvalCenterSearch",
      "approvalCenterListTitle", "approvalCenterListMeta", "approvalCenterListNote",
      "approvalDetailTitle", "approvalDetailSection",
    ]) {
      expect(source).toContain(`styles.${className}`);
    }
    expect(source).toContain("`${styles.badge} ${");
  });

  it("桌面使用队列、列表、详情三栏，业务分类只显示真实计数或当前选择", () => {
    for (const className of [
      "approvalCenterDesktopLayout", "approvalCenterNav", "approvalCenterMiddle",
      "approvalCenterDetailPane", "approvalCenterQueueList", "approvalCenterCategoryList",
    ]) {
      expect(source).toContain(`styles.${className}`);
    }
    expect(source).toContain("const visibleTypes = TYPES.filter");
    expect(source).toContain("typeCounts[option.id]");
  });

  it("搜索、时间、状态和排序筛选全部传给统一读接口", () => {
    for (const queryKey of ["q", "from", "status", "sort"]) {
      expect(source).toContain(`params.set(\"${queryKey}\"`);
    }
    for (const label of ["时间筛选", "状态筛选", "排序方式"]) {
      expect(source).toContain(`aria-label=\"${label}\"`);
    }
    expect(source).not.toContain("setSort(nextView");
  });

  it("手机按队列、列表、详情逐级导航，主视图页签保持单行", () => {
    expect(source).toContain('type MobileLevel = "queues" | "items" | "detail"');
    expect(source).toContain("approvalCenterMobileQueues");
    expect(source).toContain("approvalCenterMobileItems");
    expect(styles).toMatch(/\.approvalCenterMobileTabs button\s*\{[\s\S]*?white-space:\s*nowrap/);
  });

  it("456px 保持统计块紧凑横排，319–360px 改为三条横行并收紧留白", () => {
    expect(styles).toContain("@media (min-width: 361px) and (max-width: 500px)");
    expect(styles).toMatch(/@media \(max-width: 360px\)[\s\S]*?\.approvalCenterSummary\s*\{\s*grid-template-columns:\s*1fr/);
    expect(styles).toMatch(/@media \(max-width: 360px\)[\s\S]*?\.approvalCenterSummary > div\s*\{[\s\S]*?min-height:\s*46px/);
  });
});
