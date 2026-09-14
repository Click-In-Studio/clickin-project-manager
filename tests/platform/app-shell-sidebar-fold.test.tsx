// @vitest-environment jsdom
//
// #487 A2：AppShell 侧栏折叠簇出 hook。五个 boolean 之间的迁移规则是这一簇唯一的
// 非平凡逻辑——剧本页由视口宽度自动折、窄屏时以浮层临时展开、非剧本页手动折、内容
// 折叠比外壳晚一拍。搬家前后必须一致，这里把这几条迁移钉住。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSidebarFold } from "@/components/shell/app-shell/use-sidebar-fold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── matchMedia 替身：按 query 字符串各自可控 ─────────────────────────────────
const FOLD_QUERY = "(max-width: 1495px)";
const HIDDEN_QUERY = "(max-width: 1023px)";
const mediaState: Record<string, boolean> = {};
const mediaListeners: Record<string, Set<() => void>> = {};

function fakeMatchMedia(query: string): MediaQueryList {
  const listeners = (mediaListeners[query] ??= new Set());
  return {
    get matches() { return mediaState[query] ?? false; },
    media: query,
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
  } as unknown as MediaQueryList;
}

function setViewport(width: number) {
  mediaState[FOLD_QUERY] = width <= 1495;
  mediaState[HIDDEN_QUERY] = width <= 1023;
  act(() => {
    for (const q of [FOLD_QUERY, HIDDEN_QUERY]) for (const fn of [...(mediaListeners[q] ?? [])]) fn();
  });
}

type Snapshot = ReturnType<typeof useSidebarFold>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe({ isScriptPage }: { isScriptPage: boolean }) {
  seen.push(useSidebarFold({ isScriptPage }));
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seen.length = 0;
  vi.useFakeTimers();
  for (const k of Object.keys(mediaState)) delete mediaState[k];
  for (const k of Object.keys(mediaListeners)) delete mediaListeners[k];
  window.matchMedia = fakeMatchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(isScriptPage: boolean, width = 1920) {
  mediaState[FOLD_QUERY] = width <= 1495;
  mediaState[HIDDEN_QUERY] = width <= 1023;
  act(() => root.render(<Probe isScriptPage={isScriptPage} />));
}
function settleContentFold() { act(() => { vi.advanceTimersByTime(150 + 20 + 1); }); }

describe("useSidebarFold — 非剧本页", () => {
  it("由 generalSidebarFolded 一个开关同时决定外壳与内容，没有延迟", () => {
    mount(false);
    expect(latest().productionSidebarFolded).toBe(false);
    expect(latest().productionSidebarContentFolded).toBe(false);
    act(() => latest().setGeneralSidebarFolded(true));
    expect(latest().productionSidebarFolded).toBe(true);
    expect(latest().productionSidebarContentFolded).toBe(true);
    expect(latest().productionSidebarOverlayOpen).toBe(false);
  });

  it("视口变窄不影响非剧本页", () => {
    mount(false);
    setViewport(1200);
    expect(latest().productionSidebarFolded).toBe(false);
  });
});

describe("useSidebarFold — 剧本页", () => {
  it("宽屏：手动 toggle 折叠，内容晚一拍跟上", () => {
    mount(true);
    expect(latest().productionSidebarFolded).toBe(false);
    act(() => latest().toggleScriptProductionSidebar());
    expect(latest().productionSidebarFolded).toBe(true);
    expect(latest().productionSidebarContentFolded).toBe(false);
    settleContentFold();
    expect(latest().productionSidebarContentFolded).toBe(true);
    act(() => latest().toggleScriptProductionSidebar());
    expect(latest().productionSidebarFolded).toBe(false);
  });

  it("窄于 1496：自动折叠，toggle 变成开浮层而不是改手动折叠", () => {
    mount(true, 1200);
    expect(latest().productionSidebarFolded).toBe(true);
    expect(latest().productionSidebarOverlayOpen).toBe(false);
    act(() => latest().toggleScriptProductionSidebar());
    expect(latest().productionSidebarOverlayOpen).toBe(true);
    // 浮层开着 = 外壳视为未折叠
    expect(latest().productionSidebarFolded).toBe(false);
    act(() => latest().toggleScriptProductionSidebar());
    expect(latest().productionSidebarOverlayOpen).toBe(false);
    expect(latest().productionSidebarFolded).toBe(true);
  });

  it("浮层开着时视口拉宽回自动折叠阈值以上 → 浮层关、回到手动折叠状态", () => {
    mount(true, 1200);
    act(() => latest().toggleScriptProductionSidebar());
    expect(latest().productionSidebarOverlayOpen).toBe(true);
    setViewport(1920);
    expect(latest().productionSidebarOverlayOpen).toBe(false);
    expect(latest().productionSidebarFolded).toBe(false); // 从未手动折过
  });

  it("浮层开着时缩到 1024 以下（侧栏整体隐藏）→ 浮层关", () => {
    mount(true, 1200);
    act(() => latest().toggleScriptProductionSidebar());
    setViewport(800);
    expect(latest().productionSidebarOverlayOpen).toBe(false);
    expect(latest().productionSidebarFolded).toBe(true);
  });

  it("离开剧本页四个剧本态全部清零，不把浮层 / 手动折叠带到别的页", () => {
    mount(true, 1200);
    act(() => latest().toggleScriptProductionSidebar());
    expect(latest().productionSidebarOverlayOpen).toBe(true);
    act(() => root.render(<Probe isScriptPage={false} />));
    expect(latest().productionSidebarOverlayOpen).toBe(false);
    expect(latest().productionSidebarFolded).toBe(false);
    // 再回剧本页：从头按视口算，浮层不残留
    act(() => root.render(<Probe isScriptPage={true} />));
    expect(latest().productionSidebarOverlayOpen).toBe(false);
    expect(latest().productionSidebarFolded).toBe(true);
  });
});
