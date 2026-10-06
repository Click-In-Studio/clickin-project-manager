// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
  ProductionTopMenuContext,
} from "@/components/shell/ProductionTopMenu";
import {
  ADMIN_NAV_GROUPS,
  PRODUCTION_TOP_MENU_LABELS,
  adminTopMenuLabel,
} from "@/components/shell/app-shell/nav-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderContext(label: string, stage: number, side: "overview" | "script" | "stage" = "script") {
  act(() => root.render(
    <ProductionToolbarContext.Provider value={{
      stage: stage as (typeof PRODUCTION_TOOLBAR_STAGE)[keyof typeof PRODUCTION_TOOLBAR_STAGE],
      closeOverflow: () => {},
      overflowOpen: false,
      hasStoredControls: false,
      setHasStoredControls: () => {},
    }}>
      <ProductionTopMenuContext label={label} side={side} />
    </ProductionToolbarContext.Provider>,
  ));
  return container.querySelector<HTMLElement>(`[data-production-top-menu-context="${label}"]`)!;
}

describe("共享项目工具栏上下文", () => {
  it.each([
    ["剧本", PRODUCTION_TOOLBAR_STAGE.full],
    ["Cue", PRODUCTION_TOOLBAR_STAGE.primaryShort],
  ] as const)("宽窄阶段的 %s 都只保留带边框的模块标识", (label, stage) => {
    const context = renderContext(label, stage);
    expect(context.textContent).toBe(label);
    expect(context.className).not.toContain("flex-col");
    expect(context.lastElementChild?.className).toContain("border");
  });

  it.each([
    ["overview", "我的工作", "border-[#cbd2cf]", "bg-[var(--surface-2)]"],
    ["script", "构作", "border-[#bfd4d6]", "bg-[#edf5f5]"],
    ["stage", "人员", "border-[#e3c9b9]", "bg-[#f8eee7]"],
  ] as const)("%s 类模块使用与侧边栏一致的色系", (side, label, border, background) => {
    const context = renderContext(label, PRODUCTION_TOOLBAR_STAGE.full, side);
    expect(context.dataset.productionTopMenuSide).toBe(side);
    expect(context.lastElementChild?.className).toContain(border);
    expect(context.lastElementChild?.className).toContain(background);
  });

  it("项目总览与制作侧全部路由都有明确的顶部栏标签", () => {
    const expected = {
      "": "我的工作",
      notifications: "我的通知",
      announcements: "我的通知",
      "access-requests": "审批",
      contacts: "人员",
      planning: "计划与日程",
      events: "事件",
      tasks: "任务",
      reports: "报告",
      wiki: "云文档",
      finance: "财务",
      materials: "物料",
      assets: "资产工作台",
    };
    expect(PRODUCTION_TOP_MENU_LABELS).toMatchObject(expected);

    const overviewLabels = new Set(["我的工作", "我的通知", "审批"]);
    for (const label of new Set(Object.values(expected))) {
      const context = renderContext(
        label,
        PRODUCTION_TOOLBAR_STAGE.primaryShort,
        overviewLabels.has(label) ? "overview" : "stage",
      );
      expect(context.textContent).toBe(label);
      expect(context.lastElementChild?.className).toContain("border");
    }
  });

  it("配置中心全部导航项从同一份导航配置取得顶部栏标题", () => {
    const adminItems = ADMIN_NAV_GROUPS.flatMap((group) => group.items);
    expect(adminItems).toHaveLength(16);
    for (const item of adminItems) {
      expect(adminTopMenuLabel(item.path)).toBe(item.label);
      const context = renderContext(item.label, PRODUCTION_TOOLBAR_STAGE.primaryStored, "stage");
      expect(context.textContent).toBe(item.label);
    }
    expect(adminTopMenuLabel("unknown-admin-page")).toBeNull();
  });
});
