// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRundownScrollHandoff } from "@/components/ops/planning/rundown-scroll-handoff";

function setScrollMetrics(element: HTMLElement, scrollTop: number) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

function touchEvent(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
  });
  return event;
}

describe("Rundown 滚动边界交接事件接线", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("鼠标滚轮和触控板在首次顶部手势停住，下一手势放行外层", () => {
    const element = document.createElement("div");
    setScrollMetrics(element, 0);
    const cleanup = installRundownScrollHandoff(element);

    const first = new WheelEvent("wheel", { deltaY: -30, cancelable: true });
    element.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);

    vi.advanceTimersByTime(150);
    const second = new WheelEvent("wheel", { deltaY: -30, cancelable: true });
    element.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);

    cleanup();
  });

  it("触摸滚动在首次底部手势停住，新手势放行外层", () => {
    const element = document.createElement("div");
    setScrollMetrics(element, 600);
    const cleanup = installRundownScrollHandoff(element);

    element.dispatchEvent(touchEvent("touchstart", 50, 100));
    const firstMove = touchEvent("touchmove", 50, 70);
    element.dispatchEvent(firstMove);
    expect(firstMove.defaultPrevented).toBe(true);
    element.dispatchEvent(touchEvent("touchend", 50, 70));

    element.dispatchEvent(touchEvent("touchstart", 50, 100));
    const secondMove = touchEvent("touchmove", 50, 70);
    element.dispatchEvent(secondMove);
    expect(secondMove.defaultPrevented).toBe(false);

    cleanup();
  });
});
