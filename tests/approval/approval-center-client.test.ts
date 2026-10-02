import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("components/approval/ApprovalCenterClient.tsx", "utf8");

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
      "approvalCenterPrimaryTabs", "approvalCenterTypeFilters", "approvalCenterSearch",
      "approvalCenterListTitle", "approvalCenterListMeta", "mobileCardProduction", "mobileCardTime",
      "approvalDetailTitle", "approvalDetailSection",
    ]) {
      expect(source).toContain(`styles.${className}`);
    }
    expect(source).toContain("`${styles.badge} ${");
  });
});
