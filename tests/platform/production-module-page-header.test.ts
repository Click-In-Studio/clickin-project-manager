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

describe("项目模块标题只在共享顶部栏出现", () => {
  it.each(moduleListSources)("%s 不再渲染重复的模块 PageHeader", (file) => {
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

  it("详情页继续保留实体标题", () => {
    expect(readFileSync("components/ops/EventDetailClient.tsx", "utf8")).toContain("{event.title}");
    expect(readFileSync("components/ops/ReqDetailClient.tsx", "utf8")).toContain("title={displayTitle}");
    expect(readFileSync("components/ops/ReportViewClient.tsx", "utf8")).toContain("{report.title}");
    expect(readFileSync("components/wiki/WikiDocClient.tsx", "utf8")).toContain("value={title}");
    expect(readFileSync("components/assets/AssetPreviewClient.tsx", "utf8")).toContain("{fileName}");
  });

  it("紧凑顶栏取消会抵消父级 gap 的负外边距", () => {
    const shell = readFileSync("components/shell/AppShell.tsx", "utf8");
    expect(shell).toContain('productionHeaderStage >= 2 ? "ml-0" : "-ml-2"');
  });
});
