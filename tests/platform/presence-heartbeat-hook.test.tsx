// @vitest-environment jsdom
//
// #578：在场心跳。在场表按 updatedAt 过期，光标上报却是「变化时上报」——安静读
// 文档的人过了窗口就被清出在场表，连接明明健康。这里钉三层——
//   ① hook 本身：可见期间按间隔重发、隐藏即停、切回标签页立刻补一拍、首次挂载不补；
//   ② 契约：心跳间隔 < 过期 / 2，留一拍丢失余量；
//   ③ 静态棘轮：三域的在场 hook 真的接上了心跳。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { usePresenceHeartbeat } from "@/hooks/usePresenceHeartbeat";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from "@/lib/presence-heartbeat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let visibility: "visible" | "hidden" = "visible";
function setVisibility(next: "visible" | "hidden") {
  visibility = next;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Probe({ send, enabled }: { send: () => void; enabled?: boolean }) {
  usePresenceHeartbeat(send, enabled);
  return null;
}
const mount = (node: React.ReactNode) => act(() => root.render(node));
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("usePresenceHeartbeat", () => {
  it("首次挂载不发；之后每个间隔发一次", () => {
    const send = vi.fn();
    mount(<Probe send={send} />);
    expect(send).not.toHaveBeenCalled();
    tick(PRESENCE_HEARTBEAT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    tick(1);
    expect(send).toHaveBeenCalledTimes(1);
    tick(PRESENCE_HEARTBEAT_MS * 2);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("隐藏即停（后台标签已出场，续命就是造幽灵）；切回立刻补一拍再按间隔", () => {
    const send = vi.fn();
    mount(<Probe send={send} />);
    tick(PRESENCE_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    tick(PRESENCE_HEARTBEAT_MS * 5);
    expect(send).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(send).toHaveBeenCalledTimes(2); // 隐藏期间条目可能已过期，不等下一拍
    tick(PRESENCE_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("enabled=false 不发；卸载后不再发", () => {
    const send = vi.fn();
    mount(<Probe send={send} enabled={false} />);
    tick(PRESENCE_HEARTBEAT_MS * 3);
    expect(send).not.toHaveBeenCalled();

    mount(<Probe send={send} enabled />);
    tick(PRESENCE_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container); // afterEach 还要 unmount 一次
    tick(PRESENCE_HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("send 经 ref 取最新闭包，重渲染换函数不重置计时", () => {
    const seen: string[] = [];
    mount(<Probe send={() => seen.push("a")} />);
    tick(PRESENCE_HEARTBEAT_MS / 2);
    mount(<Probe send={() => seen.push("b")} />);
    tick(PRESENCE_HEARTBEAT_MS / 2);
    expect(seen).toEqual(["b"]);
  });
});

describe("契约：心跳留一拍余量", () => {
  it("PRESENCE_HEARTBEAT_MS * 2 <= PRESENCE_STALE_MS", () => {
    expect(PRESENCE_HEARTBEAT_MS * 2).toBeLessThanOrEqual(PRESENCE_STALE_MS);
  });
});

describe("接线棘轮：三域在场 hook 都接了心跳", () => {
  it.each([
    ["components/script/script-editor/use-script-presence.ts"],
    ["components/ops/cue-page/use-cue-presence.ts"],
    ["components/wiki/WikiDocClient.tsx"],
  ])("%s 调用 usePresenceHeartbeat", (file) => {
    expect(readFileSync(file, "utf8")).toContain("usePresenceHeartbeat(");
  });

  it("服务端过期窗口不再各自硬编码 90_000", () => {
    for (const file of ["lib/server-cache.ts", "lib/wiki/collab.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("PRESENCE_STALE_MS");
      expect(src, file).not.toContain("90_000");
    }
  });
});
