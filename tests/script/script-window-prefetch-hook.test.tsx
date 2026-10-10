// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScriptWindowPrefetch } from "@/components/script/script-editor/use-script-window-prefetch";
import { ScriptDocument } from "@/components/script/script-editor/script-document";
import { ScriptWindowRequests } from "@/components/script/script-editor/script-window-requests";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script/script-types";
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
const script = new ScriptDocument({
  versionId: "version-1", orderRevision: "rev-1", manifest: blocks.map(block => ({ ...block, lyric: false, sceneId: null, rehearsalMark: null })),
  window: { start: 400, blocks: blocks.slice(400, 640), tags: [] },
  characters: [], scenes: [], config: DEFAULT_SCRIPT_CONFIG, tagGroups: [], pageMap: {},
});
const rangeRef = { current: { start: 400, end: 640 } };
const requests = new ScriptWindowRequests();
const isSaving = () => false;
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
    script,
    isSaving,
    viewportRange: viewport,
    windowRangeRef: rangeRef,
    requests,
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
  requests.cancel();
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
    const { controller: foreground } = requests.begin("foreground");
    act(() => root.render(<Probe viewport={{ start: 400, end: 640 }} />));
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(client.fetchScriptWindow).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(foreground.signal.aborted).toBe(false);
    root = createRoot(container);
  });
});
