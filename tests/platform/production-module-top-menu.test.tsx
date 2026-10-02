// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ProductionModuleTopMenu from "@/components/shell/ProductionModuleTopMenu";
import {
  PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SLOT_ID,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
} from "@/components/shell/ProductionTopMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let toolbarSlot: HTMLDivElement;
let overflowSlot: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  toolbarSlot = document.createElement("div");
  toolbarSlot.id = PRODUCTION_TOP_MENU_SLOT_ID;
  overflowSlot = document.createElement("div");
  overflowSlot.id = PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID;
  document.body.append(container, toolbarSlot, overflowSlot);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  toolbarSlot.remove();
  overflowSlot.remove();
});

function renderAt(stage: number) {
  act(() => root.render(
    <ProductionToolbarContext.Provider value={{
      stage: stage as (typeof PRODUCTION_TOOLBAR_STAGE)[keyof typeof PRODUCTION_TOOLBAR_STAGE],
      closeOverflow: () => {},
      overflowOpen: false,
      hasStoredControls: false,
      setHasStoredControls: () => {},
    }}>
      <ProductionModuleTopMenu
        label="财务"
        primaryAction={<button>新建报销</button>}
        primaryShortAction={<button aria-label="新建报销">＋</button>}
        primaryOverflowAction={<button>更多里的新建报销</button>}
        secondaryActions={<a href="/budget">管理预算</a>}
        secondaryOverflowActions={<a href="/budget">更多里的管理预算</a>}
      />
    </ProductionToolbarContext.Provider>,
  ));
}

describe("制作侧共享顶部栏操作收缩", () => {
  it("宽屏只显示带制作侧配色的模块名、主操作与次操作", () => {
    renderAt(PRODUCTION_TOOLBAR_STAGE.full);
    expect(toolbarSlot.textContent).not.toContain("海边的剧");
    expect(toolbarSlot.textContent).toContain("财务");
    expect(toolbarSlot.querySelector('[data-production-top-menu-side="stage"]')?.lastElementChild?.className)
      .toContain("bg-[#f8eee7]");
    expect(toolbarSlot.textContent).toContain("新建报销");
    expect(toolbarSlot.textContent).toContain("管理预算");
    expect(overflowSlot.textContent).toBe("");
  });

  it("次操作先进入更多，主操作随后缩短", () => {
    renderAt(PRODUCTION_TOOLBAR_STAGE.secondaryStored);
    expect(toolbarSlot.textContent).toContain("新建报销");
    expect(toolbarSlot.textContent).not.toContain("管理预算");
    expect(overflowSlot.textContent).toContain("更多里的管理预算");

    renderAt(PRODUCTION_TOOLBAR_STAGE.primaryShort);
    expect(toolbarSlot.querySelector('[aria-label="新建报销"]')?.textContent).toBe("＋");
    expect(toolbarSlot.textContent).toContain("财务");
  });

  it("最窄阶段仍显示模块，全部页面操作可从更多到达", () => {
    renderAt(PRODUCTION_TOOLBAR_STAGE.primaryStored);
    expect(toolbarSlot.textContent).toBe("财务");
    expect(overflowSlot.textContent).toContain("更多里的新建报销");
    expect(overflowSlot.textContent).toContain("更多里的管理预算");
  });
});
