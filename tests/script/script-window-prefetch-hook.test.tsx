// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScriptWindowPrefetch, type ScriptWindowRequest } from "@/components/script/script-editor/use-script-window-prefetch";
import type { Block } from "@/lib/script/script-types";

const client = vi.hoisted(() => ({
  fetchScriptWindow: vi.fn(),
  fetchScriptWindowBootstrap: vi.fn(),
}));
vi.mock("@/lib/script/script-client", () => client);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const blocks = Array.from({ length: 1_000 }, (_, index) => ({
  id: `b${index}`, type: "dialogue", content: "", characterIds: [],
}) as unknown as Block);
const blocksRef = { current: blocks };
const rangeRef = { current: { start: 400, end: 640 } };
const manifestRef = { current: new Set(blocks.map((block) => block.id)) };
const loadedRef = { current: new Set(blocks.slice(400, 640).map((block) => block.id)) };
const requestRef = { current: null as ScriptWindowRequest | null };
const generationRef = { current: 0 };
const revisionRef = { current: "rev-1" };
const syncingRef = { current: false };
const mergeWindow = vi.fn(() => true);
const applyBootstrap = vi.fn();

function Probe({ viewport }: { viewport: { start: number; end: number } }) {
  rangeRef.current = viewport;
  useScriptWindowPrefetch({
    enabled: true,
    scriptId: "prod-1",
    versionId: "version-1",
    syncWaitingForNetwork: false,
    initialWindowSize: 240,
    blocksRef,
    viewportRange: viewport,
    windowRangeRef: rangeRef,
    manifestBlockIdsRef: manifestRef,
    loadedBlockIdsRef: loadedRef,
    requestRef,
    requestGenerationRef: generationRef,
    orderRevisionRef: revisionRef,
    isSyncingRef: syncingRef,
    mergeWindow,
    applyBootstrap,
  });
  return null;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  client.fetchScriptWindow.mockReset();
  client.fetchScriptWindowBootstrap.mockReset();
  mergeWindow.mockClear();
  applyBootstrap.mockClear();
  requestRef.current = null;
  generationRef.current = 0;
  rangeRef.current = { start: 400, end: 640 };
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => { callback({ didTimeout: false, timeRemaining: () => 10 }); return 1; });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
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

describe("剧本空闲补窗 hook（#641）", () => {
  it("停留后启动低优先级邻窗，视窗变化立即取消", async () => {
    client.fetchScriptWindow.mockImplementation(() => new Promise(() => {}));
    act(() => root.render(<Probe viewport={{ start: 400, end: 640 }} />));
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });

    expect(client.fetchScriptWindow).toHaveBeenCalledWith(
      "prod-1", "version-1", 640, 360, "rev-1", expect.any(AbortSignal),
    );
    const signal = client.fetchScriptWindow.mock.calls[0][5] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => root.render(<Probe viewport={{ start: 100, end: 340 }} />));
    expect(signal.aborted).toBe(true);
  });

  it("前台请求占用请求槽时不并发发起预取，也不取消前台", async () => {
    const foreground = new AbortController();
    requestRef.current = { controller: foreground, priority: "foreground" };
    act(() => root.render(<Probe viewport={{ start: 400, end: 640 }} />));
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(client.fetchScriptWindow).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(foreground.signal.aborted).toBe(false);
    root = createRoot(container);
  });
});
