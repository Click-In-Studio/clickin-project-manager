// @vitest-environment jsdom
//
// #487 C2：CuePage 顶栏菜单簇出 hook。钉三件事：跳转目标选中即关菜单并清输入、再点同一目标取消；
// 子菜单操作不收起第二栏；外点关闭子菜单，点自己的面板 / 触发钮不关。
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PRODUCTION_TOOLBAR_STAGE, ProductionToolbarContext } from "@/components/shell/ProductionTopMenu";
import { useCueToolbarMenus } from "@/components/ops/cue-page/use-cue-toolbar-menus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// useAnchoredMenu 开菜单时挂 ResizeObserver，jsdom 没有
class NoopObserver { observe() {} disconnect() {} unobserve() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopObserver;

type Snapshot = ReturnType<typeof useCueToolbarMenus>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe() {
  seen.push(useCueToolbarMenus());
  return (
    <div>
      <button data-cue-toolbar-menu-trigger="jump" data-testid="trigger-jump" />
      <div data-cue-toolbar-menu-panel="jump" data-testid="panel-jump" />
      <div data-cue-toolbar-menu-panel="settings" data-testid="panel-settings" />
    </div>
  );
}

function Harness() {
  const [expanded, setExpanded] = useState(true);
  return <ProductionToolbarContext.Provider value={{
    stage: PRODUCTION_TOOLBAR_STAGE.full,
    overflowOpen: expanded,
    closeOverflow: () => setExpanded(false),
    hasStoredControls: true,
    setHasStoredControls: () => {},
  }}><output data-testid="second-state">{expanded ? "展开" : "收起"}</output><Probe /></ProductionToolbarContext.Provider>;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seen.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render() {
  act(() => root.render(<Harness />));
}
function mousedown(el: EventTarget) { act(() => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); }); }

describe("useCueToolbarMenus — 跳转目标", () => {
  it("选中目标：清输入、只关子菜单、保留第二栏；再选同一目标即取消", () => {
    render();
    act(() => latest().toggleToolbarMenu("active"));
    act(() => latest().setJumpValue("12"));
    act(() => latest().selectJumpTarget("line"));
    expect(latest().jumpTarget).toBe("line");
    expect(latest().jumpValue).toBe("");
    expect(latest().openToolbarMenu).toBe(null);
    expect(container.querySelector('[data-testid="second-state"]')?.textContent).toBe("展开");
    act(() => latest().setJumpValue("3"));
    act(() => latest().selectJumpTarget("line"));
    expect(latest().jumpTarget).toBe(null);
    expect(latest().jumpValue).toBe("");
    expect(latest().openToolbarMenu).toBe(null);
    expect(container.querySelector('[data-testid="second-state"]')?.textContent).toBe("展开");
  });
});

describe("useCueToolbarMenus — 两栏之间保持菜单", () => {
  it("重新渲染不收起子菜单；只有完成动作或外点关闭", () => {
    render();
    act(() => latest().toggleToolbarMenu("jump"));
    render();
    expect(latest().openToolbarMenu).toBe("jump");
    act(() => latest().finishToolbarAction());
    expect(latest().openToolbarMenu).toBe(null);
    expect(container.querySelector('[data-testid="second-state"]')?.textContent).toBe("展开");
  });
});

describe("useCueToolbarMenus — 外点关闭", () => {
  it("点自己的面板或触发钮不关；点别的面板或空白处关", () => {
    render();
    act(() => latest().toggleToolbarMenu("jump"));
    mousedown(container.querySelector('[data-testid="panel-jump"]')!);
    expect(latest().openToolbarMenu).toBe("jump");
    mousedown(container.querySelector('[data-testid="trigger-jump"]')!);
    expect(latest().openToolbarMenu).toBe("jump");
    mousedown(container.querySelector('[data-testid="panel-settings"]')!);
    expect(latest().openToolbarMenu).toBe(null);
    act(() => latest().toggleToolbarMenu("jump"));
    mousedown(document.body);
    expect(latest().openToolbarMenu).toBe(null);
  });
});
