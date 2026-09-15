// @vitest-environment jsdom
//
// #487 S4：display 与移动端菜单两个小 hook。display 这次把原本分在两处的 state（行号列宽）
// 和 effect（cookie + 测量）合到一处，钉住 cookie 往返与「关行号即清宽」；移动端菜单钉
// 捕获阶段外点关闭——点菜单自身 / 块工具条不关，点别处关且吞掉该 click。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useDisplaySettings } from "@/components/script/script-editor/use-display-settings";
import { useMobileBlockMenus } from "@/components/script/script-editor/use-mobile-block-menus";
import { DEFAULT_DISPLAY, DISPLAY_COOKIE } from "@/components/script/script-editor/display-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopObserver { observe() {} disconnect() {} unobserve() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopObserver;

let container: HTMLDivElement;
let root: Root;
function clearCookies() {
  for (const c of document.cookie.split(";")) { const k = c.split("=")[0]?.trim(); if (k) document.cookie = `${k}=; path=/; max-age=0`; }
}
function cookie(key: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
beforeEach(() => {
  clearCookies();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

// ── display ──────────────────────────────────────────────────────────────────
type DisplaySnap = ReturnType<typeof useDisplaySettings>;
const dseen: DisplaySnap[] = [];
const dlatest = () => dseen[dseen.length - 1];
const rect = { width: 0 };
function DisplayProbe() {
  const s = useDisplaySettings({ maxLineIndexText: "123" });
  dseen.push(s);
  return (<>
    <span ref={s.lineIndexMeasureRef} />
    <span ref={s.lineIndexMinMeasureRef} />
  </>);
}

describe("useDisplaySettings", () => {
  beforeEach(() => {
    dseen.length = 0;
    rect.width = 0;
    Element.prototype.getBoundingClientRect = () => ({ width: rect.width, height: 0, top: 0, left: 0, right: rect.width, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  });

  it("无 cookie 取默认；toggle 翻转并写回 cookie；再挂载时从 cookie 恢复", () => {
    act(() => root.render(<DisplayProbe />));
    expect(dlatest().display).toEqual(DEFAULT_DISPLAY);
    act(() => dlatest().toggleDisplay("pageBreaks"));
    expect(dlatest().display.pageBreaks).toBe(false);
    expect(JSON.parse(cookie(DISPLAY_COOKIE)!)).toEqual({ ...DEFAULT_DISPLAY, pageBreaks: false });
    act(() => root.unmount());
    root = createRoot(container);
    dseen.length = 0;
    act(() => root.render(<DisplayProbe />));
    expect(dlatest().display.pageBreaks).toBe(false);
  });

  it("行号开着按测量 span 给宽；关掉行号即清宽、样式为 undefined", () => {
    rect.width = 24.2;
    act(() => root.render(<DisplayProbe />));
    expect(dlatest().lineIndexWidthStyle).toBe("25px"); // ceil
    expect(dlatest().markerLineIndexWidthStyle).toBe("25px");
    act(() => dlatest().toggleDisplay("lineNumbers"));
    expect(dlatest().display.lineNumbers).toBe(false);
    expect(dlatest().lineIndexWidthStyle).toBe(undefined);
    expect(dlatest().markerLineIndexWidthStyle).toBe(undefined);
  });
});

// ── mobile menus ─────────────────────────────────────────────────────────────
type MobileSnap = ReturnType<typeof useMobileBlockMenus>;
const mseen: MobileSnap[] = [];
const mlatest = () => mseen[mseen.length - 1];
const bubbled = vi.fn();
function MobileProbe() {
  mseen.push(useMobileBlockMenus());
  return (
    <div onClick={bubbled}>
      <div data-script-mobile-block-menu="true" data-testid="menu" />
      <div data-script-block-bar="true" data-testid="bar" />
      <div data-script-block-bar="true" data-script-marker-bar="true" data-testid="marker-bar" />
      <div data-testid="elsewhere" />
    </div>
  );
}
function click(id: string) { act(() => { (container.querySelector(`[data-testid="${id}"]`) as HTMLElement).click(); }); }

describe("useMobileBlockMenus", () => {
  beforeEach(() => { mseen.length = 0; bubbled.mockReset(); act(() => root.render(<MobileProbe />)); });

  it("菜单没开时不拦任何点击", () => {
    click("elsewhere");
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("菜单开着：点菜单自身 / 块工具条不关；点标记条或别处关掉三态并吞掉该 click", () => {
    act(() => { mlatest().setMobileBlockMenuBlockId("b1"); mlatest().setMobileInsertMenuOpen(true); mlatest().setMobileBatchAction("type"); });
    click("menu");
    click("bar");
    expect(mlatest().mobileBlockMenuBlockId).toBe("b1");
    expect(bubbled).toHaveBeenCalledTimes(2);
    click("marker-bar");
    expect(mlatest().mobileBlockMenuBlockId).toBe(null);
    expect(mlatest().mobileInsertMenuOpen).toBe(false);
    expect(mlatest().mobileBatchAction).toBe(null);
    expect(bubbled).toHaveBeenCalledTimes(2); // 捕获阶段 stopPropagation，React 的冒泡监听收不到
  });
});
