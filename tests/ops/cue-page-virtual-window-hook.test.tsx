// @vitest-environment jsdom
//
// #487 C3：CuePage 虚拟滚动窗口簇出 hook。jsdom 量不到高度（offsetHeight 恒 0），所以累计高度
// 全走 DEFAULT_BLOCK_H=80 的估算——这反而让窗口 / 垫片的算术可以精确断言。钉住：
//   初始窗口与垫片、块数缩减时窗口夹紧、滚动后按估算重算窗口、定位到窗口外的块先移窗口再
//   scrollIntoView、跳行 / 跳页 / 跳场、cookie 恢复滚动位置、高亮延迟清除。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useCueVirtualWindow } from "@/components/ops/cue-page/use-cue-virtual-window";
import type { Block } from "@/lib/script/script-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROD = "p_c3";
const N = 300;
function makeBlocks(n: number): Block[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, type: "dialogue", content: "", characterIds: [], sceneId: `s${Math.floor(i / 50)}`,
  } as unknown as Block));
}
const pageMap: Record<string, number> = { b120: 3, b121: 3 };

type Snapshot = ReturnType<typeof useCueVirtualWindow>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe({ blocks }: { blocks: Block[] }) {
  const s = useCueVirtualWindow({ blocks, productionId: PROD, pageMap });
  seen.push(s);
  return (
    <div ref={s.scrollContainerRef} data-testid="container">
      <div ref={s.topSpacerRef} />
      {blocks.slice(s.windowRange.start, s.windowRange.end).map(b => (
        <div key={b.id} data-cue-bwrap={b.id} id={`cue-block-${b.id}`} />
      ))}
      <div ref={s.botSpacerRef} />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;
const scrollIntoView = vi.fn();
function clearCookies() {
  for (const c of document.cookie.split(";")) { const k = c.split("=")[0]?.trim(); if (k) document.cookie = `${k}=; path=/; max-age=0`; }
}
function cookie(key: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

beforeEach(() => {
  seen.length = 0;
  clearCookies();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount(blocks: Block[]) { act(() => root.render(<Probe blocks={blocks} />)); }
const el = () => container.querySelector<HTMLDivElement>('[data-testid="container"]')!;

describe("useCueVirtualWindow — 窗口与垫片", () => {
  it("首屏：state 初值 [0,160)，挂载后按容器实际高度（jsdom 为 0）立刻重算成 [0, 81)，垫片按 80px 估算", () => {
    mount(makeBlocks(N));
    expect(seen[0].windowRange).toEqual({ start: 0, end: 160 });
    expect(latest().windowRange).toEqual({ start: 0, end: 81 });
    expect(latest().spacerH).toEqual({ top: 0, bot: (N - 81) * 80 });
    expect(container.querySelectorAll("[data-cue-bwrap]").length).toBe(81);
  });

  it("块数缩到窗口以内时窗口夹紧", () => {
    mount(makeBlocks(N));
    mount(makeBlocks(50));
    expect(latest().windowRange).toEqual({ start: 0, end: 50 });
    expect(latest().spacerH).toEqual({ top: 0, bot: 0 });
  });

  it("滚动后按滚动位置重算窗口（前后各 80 块缓冲）", () => {
    mount(makeBlocks(N));
    // 累计高度表只在量到高度或定位时重建；jsdom 量不到，先定位一次把表建起来（全 80px）
    act(() => latest().scrollToBlockIdx(250));
    expect(latest().windowRange).toEqual({ start: 170, end: N });
    Object.defineProperty(el(), "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(el(), "scrollTop", { configurable: true, value: 100 * 80 });
    act(() => { el().dispatchEvent(new Event("scroll")); });
    // 视口顶在第 100 块、底在第 110 块 → [20, 191)
    expect(latest().windowRange).toEqual({ start: 20, end: 191 });
    expect(latest().spacerH).toEqual({ top: 20 * 80, bot: (N - 191) * 80 });
  });
});

describe("useCueVirtualWindow — 定位", () => {
  it("目标在窗口内：直接 scrollIntoView；在窗口外：先把窗口移过去，渲染后再 scrollIntoView", () => {
    mount(makeBlocks(N));
    act(() => latest().scrollToBlockIdx(10));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("cue-block-b10"));
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: "instant", block: "center" });

    act(() => latest().scrollToBlockIdx(250, "start"));
    expect(latest().windowRange).toEqual({ start: 170, end: N });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.instances[1]).toBe(document.getElementById("cue-block-b250"));
    expect(scrollIntoView.mock.calls[1][0]).toEqual({ behavior: "instant", block: "start" });
  });

  it("jumpToLine 按 1 起算并夹在范围内；jumpToPage 找页码首块；越界不动", () => {
    mount(makeBlocks(N));
    act(() => latest().jumpToLine(1));
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("cue-block-b0"));
    act(() => latest().jumpToLine(9999));
    expect(latest().windowRange).toEqual({ start: N - 1 - 80, end: N });
    act(() => latest().jumpToPage(3));
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById("cue-block-b120"));
    const calls = scrollIntoView.mock.calls.length;
    act(() => latest().jumpToPage(99));
    expect(scrollIntoView.mock.calls.length).toBe(calls);
  });

  it("scrollToScene：场景锚点未渲染时按首块移窗口", () => {
    mount(makeBlocks(N));
    act(() => latest().scrollToScene("s4")); // 首块 b200
    expect(latest().windowRange).toEqual({ start: 120, end: 281 });
  });
});

describe("useCueVirtualWindow — cookie 与高亮", () => {
  it("挂载时按 cue_pos cookie 定位；滚动停下 400ms 后写回当前顶部块", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.cookie = `cue_pos_${PROD}=b230; path=/`;
    mount(makeBlocks(N));
    expect(latest().windowRange).toEqual({ start: 150, end: 311 > N ? N : 311 });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById("cue-block-b230"));
    act(() => { vi.advanceTimersByTime(300); }); // 解锁
    Object.defineProperty(el(), "scrollTop", { configurable: true, value: 200 * 80 });
    act(() => { el().dispatchEvent(new Event("scroll")); });
    expect(latest().windowRange).toEqual({ start: 120, end: 281 });
    act(() => { vi.advanceTimersByTime(400); });
    // jsdom 所有 rect 都是 0，「顶边不低于容器顶」对每个已渲染块都成立 → 记的是窗口里最后一块
    expect(cookie(`cue_pos_${PROD}`)).toBe("b280");
  });

  it("高亮 400ms 后点击页面即清除；400ms 内的点击不算", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(makeBlocks(N));
    act(() => latest().setHighlightedCueId("c1"));
    act(() => { document.body.click(); });
    expect(latest().highlightedCueId).toBe("c1");
    act(() => { vi.advanceTimersByTime(400); });
    act(() => { document.body.click(); });
    expect(latest().highlightedCueId).toBe(null);
  });
});
