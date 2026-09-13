import { describe, it, expect } from "vitest";
import {
  extractProductionId,
  extractCurrentWikiId,
  extractCurrentAssetId,
  extractModule,
  extractAdminModule,
} from "@/components/shell/app-shell/route";

/**
 * AppShell 从 pathname 推导「当前项目 / 模块 / 附带对象」的纯函数（#487 A1 从
 * AppShell.tsx 搬出）。这些结果驱动侧栏高亮与 AI popout 的附带 chip，错一个就是
 * 高亮跳错项或给后端送非法 id（#476）。
 */
const P = "p_abc123";

describe("extractProductionId", () => {
  it("项目路由取第一段", () => {
    expect(extractProductionId(`/production/${P}`)).toBe(P);
    expect(extractProductionId(`/production/${P}/script`)).toBe(P);
  });
  it("非项目路由为 null", () => {
    expect(extractProductionId("/")).toBe(null);
    expect(extractProductionId("/my/tasks")).toBe(null);
    expect(extractProductionId("/productions")).toBe(null);
  });
});

describe("extractCurrentWikiId", () => {
  const wikiId = "0f3a2b7c-1d2e-4f5a-9b8c-7d6e5f4a3b2c";
  it("文档详情页两个入口都认：wiki 与 dramaturgy/inspiration", () => {
    expect(extractCurrentWikiId(`/production/${P}/wiki/${wikiId}`, P)).toBe(wikiId);
    expect(extractCurrentWikiId(`/production/${P}/dramaturgy/inspiration/${wikiId}`, P)).toBe(wikiId);
    expect(extractCurrentWikiId(`/production/${P}/wiki/${wikiId}/edit`, P)).toBe(wikiId);
  });
  it("文档库根页没有具体文档", () => {
    expect(extractCurrentWikiId(`/production/${P}/wiki`, P)).toBe(null);
    expect(extractCurrentWikiId(`/production/${P}/wiki/`, P)).toBe(null);
  });
  it("nd_ 壳节点不是文档（#476）：不能拿去 fetch", () => {
    expect(extractCurrentWikiId(`/production/${P}/wiki/nd_7c2e1a9b`, P)).toBe(null);
  });
  it("别的项目 id 不匹配", () => {
    expect(extractCurrentWikiId(`/production/other/wiki/${wikiId}`, P)).toBe(null);
  });
});

describe("extractCurrentAssetId", () => {
  it("资产详情与预览页取 assetId，列表根页为 null", () => {
    expect(extractCurrentAssetId(`/production/${P}/assets/as_1`, P)).toBe("as_1");
    expect(extractCurrentAssetId(`/production/${P}/assets/as_1/preview`, P)).toBe("as_1");
    expect(extractCurrentAssetId(`/production/${P}/assets`, P)).toBe(null);
  });
});

describe("extractModule", () => {
  it("项目根为空串，其余取第一段", () => {
    expect(extractModule(`/production/${P}`, P)).toBe("");
    expect(extractModule(`/production/${P}/`, P)).toBe("");
    expect(extractModule(`/production/${P}/script`, P)).toBe("script");
    expect(extractModule(`/production/${P}/admin/roles`, P)).toBe("admin");
  });
  it("events 下的需求 / 报告子页归到 tasks / reports 高亮", () => {
    expect(extractModule(`/production/${P}/events/e1/reqs/r1`, P)).toBe("tasks");
    expect(extractModule(`/production/${P}/events/e1/reports/rp1`, P)).toBe("reports");
    expect(extractModule(`/production/${P}/events/e1`, P)).toBe("events");
  });
});

describe("extractAdminModule", () => {
  it("admin 根为空串，其余取 admin 后第一段", () => {
    expect(extractAdminModule(`/production/${P}/admin`, P)).toBe("");
    expect(extractAdminModule(`/production/${P}/admin/`, P)).toBe("");
    expect(extractAdminModule(`/production/${P}/admin/permissions/dept`, P)).toBe("permissions");
  });
});
