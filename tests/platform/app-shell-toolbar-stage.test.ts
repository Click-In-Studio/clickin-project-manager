// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { PRODUCTION_TOOLBAR_STAGE } from "@/components/shell/ProductionTopMenu";
import {
  PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX,
  productionHeaderStageForWidth,
  productionTopbarActionsMarginClass,
  adjacentProductionToolbarStage,
  productionTopbarOverflow,
} from "@/components/shell/app-shell/toolbar-stage";

/**
 * 项目头部 / 工具栏折叠阶段的纯函数（#487 A1 从 AppShell.tsx 搬出）。
 * 阶段序列是工具栏在宽度不够时逐级收纳控件的顺序，越界必须夹在两端——
 * 否则最窄 / 最宽时 ResizeObserver 会一直试图再进一级而抖动。
 */
describe("productionHeaderStageForWidth", () => {
  it("1280 / 1024 两个断点，含边界", () => {
    expect(productionHeaderStageForWidth(1920)).toBe(0);
    expect(productionHeaderStageForWidth(1280)).toBe(0);
    expect(productionHeaderStageForWidth(1279)).toBe(1);
    expect(productionHeaderStageForWidth(1024)).toBe(1);
    expect(productionHeaderStageForWidth(1023)).toBe(2);
    expect(productionHeaderStageForWidth(0)).toBe(2);
  });

  it("紧凑制作顶栏不再用负外边距抵消父级 gap", () => {
    expect(productionTopbarActionsMarginClass(true, 2)).toBe("ml-0");
    expect(productionTopbarActionsMarginClass(true, 1)).toBe("-ml-2");
    expect(productionTopbarActionsMarginClass(false, 2)).toBe("ml-auto");
  });
});

describe("adjacentProductionToolbarStage", () => {
  const S = PRODUCTION_TOOLBAR_STAGE;
  it("按收纳顺序前进 / 后退一级", () => {
    expect(adjacentProductionToolbarStage(S.full, 1)).toBe(S.searchCollapsed);
    expect(adjacentProductionToolbarStage(S.searchCollapsed, 1)).toBe(S.secondaryStored);
    expect(adjacentProductionToolbarStage(S.secondaryStored, 1)).toBe(S.primaryShort);
    expect(adjacentProductionToolbarStage(S.primaryShort, 1)).toBe(S.primaryStored);
    expect(adjacentProductionToolbarStage(S.primaryStored, 1)).toBe(S.lowPriorityStored);
    expect(adjacentProductionToolbarStage(S.lowPriorityStored, -1)).toBe(S.primaryStored);
    expect(adjacentProductionToolbarStage(S.searchCollapsed, -1)).toBe(S.full);
  });
  it("两端夹住：最宽再退 / 最窄再进都原地不动", () => {
    expect(adjacentProductionToolbarStage(S.full, -1)).toBe(S.full);
    expect(adjacentProductionToolbarStage(S.lowPriorityStored, 1)).toBe(S.lowPriorityStored);
  });
});

describe("productionTopbarOverflow", () => {
  function rect(left: number, right: number): DOMRect {
    return {
      x: left, y: 0, left, right, top: 0, bottom: 32,
      width: right - left, height: 32, toJSON: () => ({}),
    };
  }

  function toolbarWithGap(gap: number) {
    const topbar = document.createElement("header");
    const slot = document.createElement("div");
    slot.id = "production-page-toolbar-slot";
    const root = document.createElement("div");
    root.dataset.productionTopMenuRoot = "true";
    const context = document.createElement("span");
    const actions = document.createElement("div");
    context.getBoundingClientRect = () => rect(100, 140);
    actions.getBoundingClientRect = () => rect(180, 240);
    root.append(context, actions);
    slot.append(root);
    const globalActions = document.createElement("div");
    globalActions.getBoundingClientRect = () => rect(240 + gap, 300 + gap);
    topbar.append(slot, globalActions);
    Object.defineProperty(topbar, "clientWidth", { configurable: true, value: 400 });
    return topbar;
  }

  it("搜索 / 更多与页面动作少于 6px 时，即使总宽未溢出也继续收缩", () => {
    expect(productionTopbarOverflow(toolbarWithGap(-2))).toBe(
      PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX + 2,
    );
    expect(productionTopbarOverflow(toolbarWithGap(0))).toBe(
      PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX,
    );
  });

  it("保留至少 6px 可见间距后不额外触发收缩", () => {
    expect(productionTopbarOverflow(toolbarWithGap(PRODUCTION_TOOLBAR_MIN_CLEARANCE_PX))).toBe(0);
    expect(productionTopbarOverflow(toolbarWithGap(12))).toBeLessThanOrEqual(0);
  });
});
