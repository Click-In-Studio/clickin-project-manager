// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
  ProductionTopMenuContext,
} from "@/components/shell/ProductionTopMenu";

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

function renderContext(label: "剧本" | "Cue", stage: number) {
  act(() => root.render(
    <ProductionToolbarContext.Provider value={{
      stage: stage as (typeof PRODUCTION_TOOLBAR_STAGE)[keyof typeof PRODUCTION_TOOLBAR_STAGE],
      closeOverflow: () => {},
      overflowOpen: false,
      hasStoredControls: false,
      setHasStoredControls: () => {},
    }}>
      <ProductionTopMenuContext productionName="一个很长的项目名称" label={label} />
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
});
