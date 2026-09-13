import { describe, it, expect } from "vitest";
import { PRODUCTION_TOOLBAR_STAGE } from "@/components/shell/ProductionTopMenu";
import {
  productionHeaderStageForWidth,
  adjacentProductionToolbarStage,
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
