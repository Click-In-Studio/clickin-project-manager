// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
  ProductionTopMenuContext,
} from "@/components/shell/ProductionTopMenu";
import { PRODUCTION_TOP_MENU_LABELS } from "@/components/shell/app-shell/nav-config";

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

function renderContext(label: string, stage: number, side: "script" | "stage" = "script") {
  act(() => root.render(
    <ProductionToolbarContext.Provider value={{
      stage: stage as (typeof PRODUCTION_TOOLBAR_STAGE)[keyof typeof PRODUCTION_TOOLBAR_STAGE],
      closeOverflow: () => {},
      overflowOpen: false,
      hasStoredControls: false,
      setHasStoredControls: () => {},
    }}>
      <ProductionTopMenuContext productionName="一个很长的项目名称" label={label} side={side} />
    </ProductionToolbarContext.Provider>,
  ));
  return container.querySelector<HTMLElement>(`[data-production-top-menu-context="${label}"]`)!;
}

describe("共享项目工具栏上下文", () => {
  it.each(["剧本", "Cue"] as const)("桌面端 %s 保留项目名和页面名", (label) => {
    const context = renderContext(label, PRODUCTION_TOOLBAR_STAGE.full);
    expect(context.textContent).toBe(`一个很长的项目名称${label}`);
    expect(context.className).toContain("flex-col");
    expect(context.lastElementChild?.className).not.toContain("border");
  });

  it.each(["剧本", "Cue"] as const)("窄屏 %s 只保留带边框的页面标识", (label) => {
    const context = renderContext(label, PRODUCTION_TOOLBAR_STAGE.primaryShort);
    expect(context.textContent).toBe(label);
    expect(context.className).not.toContain("flex-col");
    expect(context.lastElementChild?.className).toContain("border");
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
      wiki: "知识库",
      finance: "财务",
      materials: "物料",
      assets: "资产工作台",
    };
    expect(PRODUCTION_TOP_MENU_LABELS).toMatchObject(expected);

    for (const label of new Set(Object.values(expected))) {
      const context = renderContext(label, PRODUCTION_TOOLBAR_STAGE.primaryShort, "stage");
      expect(context.textContent).toBe(label);
      expect(context.lastElementChild?.className).toContain("border");
    }
  });
});
