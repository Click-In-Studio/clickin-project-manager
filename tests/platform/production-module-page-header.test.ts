import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const moduleListSources = [
  "components/ops/ProductionHomeClient.tsx",
  "components/notify/ProductionNotificationsHub.tsx",
  "components/perm/ContactsClient.tsx",
  "app/production/[id]/planning/page.tsx",
  "app/production/[id]/tasks/page.tsx",
  "app/production/[id]/reports/page.tsx",
  "app/production/[id]/materials/page.tsx",
  "app/production/[id]/wiki/page.tsx",
  "app/production/[id]/wiki/[wikiId]/page.tsx",
];

const adminPageSources = [
  "app/production/[id]/admin/page.tsx",
  "app/production/[id]/admin/approval-flows/page.tsx",
  "app/production/[id]/admin/danger/page.tsx",
  "app/production/[id]/admin/migration/page.tsx",
  "components/admin/AdminAnnouncementsClient.tsx",
  "components/admin/AdminAssetReviewClient.tsx",
  "components/admin/AdminAuditClient.tsx",
  "components/admin/AdminFinanceClient.tsx",
  "components/admin/AdminMilestonesClient.tsx",
  "components/admin/AdminOrganizationClient.tsx",
  "components/admin/AdminPermissionCenterClient.tsx",
  "components/admin/AdminPoliciesClient.tsx",
  "components/admin/AdminProducerClient.tsx",
  "components/admin/AdminRolesClient.tsx",
  "components/admin/AdminSettingsClient.tsx",
  "components/admin/AdminTemplatesClient.tsx",
];

describe("项目模块标题只在共享顶部栏出现", () => {
  it.each(moduleListSources)("%s 不再渲染重复的模块 PageHeader", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain("<PageHeader");
  });

  it.each(adminPageSources)("%s 不再渲染重复的配置中心 PageHeader", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain("<PageHeader");
  });

  it.each([
    ["components/approval/ApprovalCenterClient.tsx", "label=\"审批\""],
    ["components/ops/EventsClient.tsx", "label=\"事件\""],
    ["app/production/[id]/finance/page.tsx", "label=\"财务\""],
    ["components/assets/AssetPageClient.tsx", "label=\"资产工作台\""],
  ])("%s 把原页头操作接入共享顶部栏", (file, marker) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("ProductionModuleTopMenu");
    expect(source).toContain(marker);
  });

  it.each([
    ["components/admin/AdminAnnouncementsClient.tsx", "label=\"公告管理\"", "新建公告"],
    ["components/admin/AdminFinanceClient.tsx", "label=\"财务设置\"", "primaryOverflowAction"],
    ["components/admin/AdminOrganizationClient.tsx", "label=\"成员与部门\"", "邀请成员"],
    ["components/admin/AdminSettingsClient.tsx", "label=\"项目信息\"", "项目已归档"],
  ])("%s 把配置中心页头动作或状态接入共享顶部栏", (file, label, action) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("ProductionModuleTopMenu");
    expect(source).toContain(label);
    expect(source).toContain(action);
  });

  it("AppShell 使用配置中心导航单一真相生成顶部栏标题", () => {
    const source = readFileSync("components/shell/AppShell.tsx", "utf8");
    expect(source).toContain("adminTopMenuLabel(activeAdminModule ?? \"\")");
  });

  it("详情页继续保留实体标题", () => {
    expect(readFileSync("components/ops/EventDetailClient.tsx", "utf8")).toContain("{event.title}");
    expect(readFileSync("components/ops/ReqDetailClient.tsx", "utf8")).toContain("title={displayTitle}");
    expect(readFileSync("components/ops/ReportViewClient.tsx", "utf8")).toContain("{report.title}");
    expect(readFileSync("components/wiki/WikiDocClient.tsx", "utf8")).toContain("value={title}");
    expect(readFileSync("components/assets/AssetPreviewClient.tsx", "utf8")).toContain("{fileName}");
  });
});
