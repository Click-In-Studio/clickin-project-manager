import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSaveDebounce } from "@/lib/editor/save-debounce";

// #515/#520：自动保存原本是纯 trailing debounce，连续打字每个击键都重置，打一大段
// 期间永远不落库。maxWait 保证自窗口起点起最迟必发一次。

describe("createSaveDebounce", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("停手后 wait 到点发一次（trailing）", () => {
    const fn = vi.fn();
    const d = createSaveDebounce(fn, { wait: 1200, maxWait: 5000 });
    d.trigger();
    vi.advanceTimersByTime(1199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(false);
  });

  /** 每 step ms 敲一次键，敲到 until（含）为止；返回时钟停在 until */
  function type(d: { trigger(): void }, from: number, until: number, step = 500) {
    for (let t = from; t <= until; t += step) {
      d.trigger();
      if (t + step <= until) vi.advanceTimersByTime(step);
    }
  }

  it("每次 trigger 重置 wait，但不超过 maxWait：连续打字期间到点必发", () => {
    const fn = vi.fn();
    const d = createSaveDebounce(fn, { wait: 1200, maxWait: 5000 });
    // 每 500ms 敲一次，纯 trailing 永远不会发；t=4500 那次距窗口起点只剩 500ms，
    // 计时器要按 500 排而不是 1200
    type(d, 0, 4500);
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("发过一次后窗口重新计：继续打字再过 maxWait 才发第二次", () => {
    const fn = vi.fn();
    const d = createSaveDebounce(fn, { wait: 1200, maxWait: 5000 });
    type(d, 0, 4500);
    vi.advanceTimersByTime(500); // t=5000 首发
    expect(fn).toHaveBeenCalledTimes(1);
    // 第二个窗口从 t=5000 的第一次 trigger 起算：到 t=10000 才发第二次
    type(d, 5000, 9500);
    vi.advanceTimersByTime(499);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel 撤掉计时器且清窗口起点：之后的 trigger 从头算", () => {
    const fn = vi.fn();
    const d = createSaveDebounce(fn, { wait: 1200, maxWait: 5000 });
    type(d, 0, 4000);
    d.cancel();
    expect(d.pending()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
    d.trigger(); // 没有沿用旧窗口（旧窗口早该到点了）：按整个 wait 排
    vi.advanceTimersByTime(1199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fn 里再 trigger（撞锁重排）：排的是新一轮，不会丢", () => {
    let reentered = false;
    const fn = vi.fn(() => { if (!reentered) { reentered = true; d.trigger(); } });
    const d = createSaveDebounce(fn, { wait: 1200, maxWait: 5000 });
    d.trigger();
    vi.advanceTimersByTime(1200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
