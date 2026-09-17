// @vitest-environment jsdom
//
// #487 S6：重排锁出 hook。钉住：lock 即锁（state + ref 同步）；unlockReorderAfterCommit 不立刻解，
// 等下一次 blocks 提交后的下一帧才解；unlock 会取消挂着的解锁帧；提示文案 1.8s 后自清。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useReorderLock } from "@/components/script/script-editor/use-reorder-lock";
import type { Block } from "@/lib/script/script-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Snapshot = ReturnType<typeof useReorderLock>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe({ blocks }: { blocks: Block[] }) {
  seen.push(useReorderLock({ blocks }));
  return null;
}
let container: HTMLDivElement;
let root: Root;
const frames: Array<() => void> = [];
beforeEach(() => {
  seen.length = 0;
  frames.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.push(fn); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = () => {}; });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const B1 = [{ id: "a" }] as unknown as Block[];
const B2 = [{ id: "a" }, { id: "b" }] as unknown as Block[];
function render(blocks: Block[]) { act(() => root.render(<Probe blocks={blocks} />)); }
function runFrames() { act(() => { const fs = frames.splice(0); fs.forEach(f => f()); }); }

describe("useReorderLock", () => {
  it("lock / unlock：state 与 ref 同步", () => {
    render(B1);
    act(() => latest().lockReorder());
    expect(latest().isReorderLocked).toBe(true);
    expect(latest().isReorderLockedRef.current).toBe(true);
    act(() => latest().unlockReorder());
    expect(latest().isReorderLocked).toBe(false);
    expect(latest().isReorderLockedRef.current).toBe(false);
  });

  it("unlockReorderAfterCommit：等 blocks 变了、再过一帧才解锁", () => {
    render(B1);
    act(() => latest().lockReorder());
    act(() => latest().unlockReorderAfterCommit());
    runFrames();
    expect(latest().isReorderLocked).toBe(true); // blocks 没变，不解
    render(B2);
    expect(latest().isReorderLocked).toBe(true); // 提交了但还没到下一帧
    runFrames();
    expect(latest().isReorderLocked).toBe(false);
    expect(latest().reorderUnlockFrame.current).toBe(null);
  });

  it("挂着解锁帧时手动 unlock 会取消那一帧；再 lock 也取消", () => {
    render(B1);
    act(() => latest().lockReorder());
    act(() => latest().unlockReorderAfterCommit());
    render(B2);
    expect(latest().reorderUnlockFrame.current).not.toBe(null);
    act(() => latest().lockReorder());
    expect(latest().reorderUnlockFrame.current).toBe(null);
    runFrames();
    expect(latest().isReorderLocked).toBe(true);
  });

  it("提示文案 1.8s 自清；连续两条以后一条为准", () => {
    render(B1);
    act(() => latest().showReorderNotice("一"));
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => latest().showReorderNotice("二"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(latest().reorderNotice).toBe("二");
    act(() => { vi.advanceTimersByTime(800); });
    expect(latest().reorderNotice).toBe("");
    expect(latest().reorderNoticeTimer.current).toBe(null);
  });
});
