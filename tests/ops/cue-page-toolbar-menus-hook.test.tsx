// @vitest-environment jsdom
//
// #487 C2：CuePage 顶栏菜单簇出 hook。钉三件事：跳转目标选中即关菜单并清输入、再点同一目标取消；
// 工具栏折叠阶段变化时「不该开着」的菜单自动收起；外点关闭但点自己的面板 / 触发钮不关。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PRODUCTION_TOOLBAR_STAGE, type ProductionToolbarStage } from "@/components/shell/ProductionTopMenu";
import { useCueToolbarMenus } from "@/components/ops/cue-page/use-cue-toolbar-menus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// useAnchoredMenu 开菜单时挂 ResizeObserver，jsdom 没有
class NoopObserver { observe() {} disconnect() {} unobserve() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopObserver;

type Snapshot = ReturnType<typeof useCueToolbarMenus>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
const closeOverflow = vi.fn();
function Probe({ stage, overflowOpen }: { stage: ProductionToolbarStage; overflowOpen: boolean }) {
  seen.push(useCueToolbarMenus({ toolbarStage: stage, overflowOpen, closeOverflow }));
  return (
    <div>
      <button data-cue-toolbar-menu-trigger="jump" data-testid="trigger-jump" />
      <div data-cue-toolbar-menu-panel="jump" data-testid="panel-jump" />
      <div data-cue-toolbar-menu-panel="settings" data-testid="panel-settings" />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seen.length = 0;
  closeOverflow.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(stage: ProductionToolbarStage, overflowOpen = false) {
  act(() => root.render(<Probe stage={stage} overflowOpen={overflowOpen} />));
}
function mousedown(el: EventTarget) { act(() => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); }); }
const S = PRODUCTION_TOOLBAR_STAGE;

describe("useCueToolbarMenus — 跳转目标", () => {
  it("选中目标：清输入、关菜单、关溢出；再选同一目标即取消", () => {
    render(S.full);
    act(() => latest().toggleToolbarMenu("active"));
    act(() => latest().setJumpValue("12"));
    act(() => latest().selectJumpTarget("line"));
    expect(latest().jumpTarget).toBe("line");
    expect(latest().jumpValue).toBe("");
    expect(latest().openToolbarMenu).toBe(null);
    expect(closeOverflow).toHaveBeenCalledTimes(1);
    act(() => latest().setJumpValue("3"));
    act(() => latest().selectJumpTarget("line"));
    expect(latest().jumpTarget).toBe(null);
    expect(latest().jumpValue).toBe("");
    expect(latest().openToolbarMenu).toBe(null);
    expect(closeOverflow).toHaveBeenCalledTimes(2);
  });
});

describe("useCueToolbarMenus — 折叠阶段联动", () => {
  it("jump 菜单只在次级菜单已折叠且未压缩时存在；阶段一变就收", () => {
    render(S.full);
    act(() => latest().toggleToolbarMenu("jump"));
    expect(latest().openToolbarMenu).toBe(null); // full：跳转框内联，菜单无意义
    render(S.secondaryStored);
    act(() => latest().toggleToolbarMenu("jump"));
    expect(latest().openToolbarMenu).toBe("jump");
    render(S.primaryStored); // compact：跳转收进溢出菜单
    expect(latest().openToolbarMenu).toBe(null);
    expect(latest().toolbarCompact).toBe(true);
  });

  it("settings 菜单在压缩态下随溢出菜单关闭而关闭", () => {
    render(S.primaryStored, true);
    act(() => latest().toggleToolbarMenu("settings"));
    expect(latest().openToolbarMenu).toBe("settings");
    render(S.primaryStored, false);
    expect(latest().openToolbarMenu).toBe(null);
  });
});

describe("useCueToolbarMenus — 外点关闭", () => {
  it("点自己的面板或触发钮不关；点别的面板或空白处关", () => {
    render(S.secondaryStored);
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
