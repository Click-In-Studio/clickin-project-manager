// @vitest-environment jsdom
//
// #467：协作 SSE 的可见性门控。浏览器对同源 HTTP/1.1 只给 6 条并发连接，后台
// 标签常驻的协作流是主要浪费来源。这里钉三层——
//   ① 门控本身：可见才连、隐藏即断、再可见重连；
//   ② 重连补齐：SSE 不补发历史帧，第二次及以后每次连上都要 onReopen（首次不调，
//      那次紧跟页面自己的初始加载，补也是白补一轮请求）；
//   ③ 静态棘轮：四处消费方真的接上了 hook。行为测试全绿而接线被换回裸
//      EventSource 是这类改动最典型的假绿。
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { useVisibleEventSource, useDocumentVisible } from "@/hooks/useVisibleEventSource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── jsdom 没有 EventSource，造一个能手动喂帧的替身 ───────────────────────────
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() { FakeEventSource.instances = []; }
  static get live() { return FakeEventSource.instances.filter(es => !es.closed); }

  closed = false;
  private handlers = new Map<string, Set<EventListener>>();

  constructor(public url: string) { FakeEventSource.instances.push(this); }

  addEventListener(type: string, fn: EventListener) {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn);
    this.handlers.set(type, set);
  }
  removeEventListener(type: string, fn: EventListener) { this.handlers.get(type)?.delete(fn); }
  close() { this.closed = true; }

  /** 服务端推一帧（`data` 省略=无载荷事件，如 open）。 */
  emit(type: string, data?: string) {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event);
  }
}

let visibility: "visible" | "hidden" = "visible";
function setVisibility(next: "visible" | "hidden") {
  visibility = next;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeEventSource.reset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(node: React.ReactNode) { act(() => root.render(node)); }

describe("useDocumentVisible", () => {
  it("跟随 visibilitychange 翻转", () => {
    const seen: boolean[] = [];
    function Probe() { seen.push(useDocumentVisible()); return null; }
    mount(<Probe />);
    expect(seen.at(-1)).toBe(true);
    setVisibility("hidden");
    expect(seen.at(-1)).toBe(false);
    setVisibility("visible");
    expect(seen.at(-1)).toBe(true);
  });

  it("首帧就在后台标签时挂载后立刻纠正（SSR 恒 visible）", () => {
    visibility = "hidden";
    const seen: boolean[] = [];
    function Probe() { seen.push(useDocumentVisible()); return null; }
    mount(<Probe />);
    expect(seen.at(-1)).toBe(false);
  });
});

describe("useVisibleEventSource — 门控", () => {
  function Probe({ url, handlers }: { url: string | null; handlers: Parameters<typeof useVisibleEventSource>[1] }) {
    useVisibleEventSource(url, handlers);
    return null;
  }

  it("可见即建连，url 原样传给 EventSource", () => {
    mount(<Probe url="/api/x/stream?cid=a" handlers={{ listeners: {} }} />);
    expect(FakeEventSource.live).toHaveLength(1);
    expect(FakeEventSource.live[0].url).toBe("/api/x/stream?cid=a");
  });

  it("url 为 null 不建连（条件未就绪）", () => {
    mount(<Probe url={null} handlers={{ listeners: {} }} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("隐藏即断、再可见重连", () => {
    mount(<Probe url="/api/x/stream" handlers={{ listeners: {} }} />);
    const first = FakeEventSource.instances[0];

    setVisibility("hidden");
    expect(first.closed).toBe(true);
    expect(FakeEventSource.live).toHaveLength(0);

    setVisibility("visible");
    expect(FakeEventSource.live).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("卸载关闭连接", () => {
    mount(<Probe url="/api/x/stream" handlers={{ listeners: {} }} />);
    const es = FakeEventSource.instances[0];
    act(() => root.unmount());
    expect(es.closed).toBe(true);
    root = createRoot(container); // afterEach 还要 unmount 一次
  });
});

describe("useVisibleEventSource — 重连补齐与在场名单", () => {
  function Probe({ handlers }: { handlers: Parameters<typeof useVisibleEventSource>[1] }) {
    useVisibleEventSource("/api/x/stream", handlers);
    return null;
  }

  it("首次 open 不调 onReopen，重连才调", () => {
    const onReopen = vi.fn();
    mount(<Probe handlers={{ onReopen, listeners: {} }} />);

    act(() => FakeEventSource.instances[0].emit("open"));
    expect(onReopen).not.toHaveBeenCalled();

    setVisibility("hidden");
    setVisibility("visible");
    act(() => FakeEventSource.instances[1].emit("open"));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("同一条连接被反代掐断后自动重连，也算重连", () => {
    // EventSource 自愈重连不会新建对象，只是再派发一次 open
    const onReopen = vi.fn();
    mount(<Probe handlers={{ onReopen, listeners: {} }} />);
    const es = FakeEventSource.instances[0];
    act(() => es.emit("open"));
    act(() => es.emit("open"));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("断开时调 onClose（本端已被服务端移出在场表）", () => {
    const onClose = vi.fn();
    mount(<Probe handlers={{ onClose, listeners: {} }} />);
    expect(onClose).not.toHaveBeenCalled();
    setVisibility("hidden");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("useVisibleEventSource — 帧分发与重连节流", () => {
  it("具名事件与默认 message 帧都分发到对应 handler", () => {
    const presence = vi.fn();
    const message = vi.fn();
    function Probe() {
      useVisibleEventSource("/api/x/stream", { listeners: { presence, message } });
      return null;
    }
    mount(<Probe />);
    const es = FakeEventSource.instances[0];
    act(() => es.emit("presence", '[{"clientId":"a"}]'));
    act(() => es.emit("message", '{"updated":true}'));

    expect(presence).toHaveBeenCalledTimes(1);
    expect((presence.mock.calls[0][0] as MessageEvent).data).toBe('[{"clientId":"a"}]');
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("重渲染换新的 handlers 对象不重连，且回调取最新闭包", () => {
    // 调用方每次渲染都会新建 listeners 对象。若 effect 依赖它，每次 setState
    // 都要断一次重连一次——门控反而变成连接风暴。
    const seen: string[] = [];
    function Probe() {
      const [tick, setTick] = useState(0);
      useVisibleEventSource("/api/x/stream", {
        listeners: { message: () => seen.push(`tick=${tick}`) },
      });
      return <button onClick={() => setTick(t => t + 1)} />;
    }
    mount(<Probe />);
    const es = FakeEventSource.instances[0];

    act(() => es.emit("message", "{}"));
    act(() => { container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    act(() => es.emit("message", "{}"));

    expect(FakeEventSource.instances).toHaveLength(1); // 没有重连
    expect(seen).toEqual(["tick=0", "tick=1"]);        // 但拿的是最新闭包
  });
});

describe("接线棘轮：四处消费方确实接上了门控", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it.each([
    ["components/CuePage.tsx"],
    ["components/ScenesManager.tsx"],
    ["components/wiki/WikiDocClient.tsx"],
  ])("%s 走 hook 建连，不留裸 EventSource", (file) => {
    const src = read(file);
    expect(src).toContain("useVisibleEventSource(");
    expect(src).not.toContain("new EventSource(");
  });

  it("ScriptEditor 用共享的可见性门（建连被 leader 选举包着，只接这一层）", () => {
    const src = read("components/ScriptEditor.tsx");
    expect(src).toContain("useDocumentVisible()");
    // 自建一套 visibilitychange 监听 = 门控又分叉了
    expect(src).not.toContain('addEventListener("visibilitychange"');
  });

  // 下面几条钉的是**接线存在**，不是行为——行为由上面 hook 层的用例保证。刻意不写成
  // 「onReopen 后 N 个字符内出现 X」：那种邻近窗口会被一次无害的重排/抽函数搞红，
  // 而它多盯住的东西并不比「这个调用点还在不在」多。
  it("CuePage 保留了变更帧触发重拉的路径", () => {
    // 旧实现挂在 es.onmessage 上。搬进 hook 时若只搬了 presence 落下 message，
    // 别人改 cue 本端就不刷新了——而这条回归在 presence 头像正常时毫无征兆。
    const src = read("components/CuePage.tsx");
    expect(src).toMatch(/message:\s*\(\)\s*=>\s*scheduleCueRefetch\(\)/);
  });

  it("CuePage 重连时清掉 presence 去重键", () => {
    // 断连即出场，重连必须重报；sendCuePresence 的「值没变就不发」会把重报吞掉，
    // 不清 lastSentPresRef 的话切回标签页后别人看不见我，直到我下次动选区。
    const src = read("components/CuePage.tsx");
    expect(src).toContain('lastSentPresRef.current = ""');
  });

  it("Wiki 的远端落地路径同时供 update 帧和重连补齐使用", () => {
    // 三路合并的 base（savedRef.body）停在陈旧版本 = 下次保存拿过期 base 覆盖别人。
    // 补齐必须走与 update 帧同一条落地路径，否则合并语义会分叉成两套。
    const src = read("components/wiki/WikiDocClient.tsx");
    const calls = src.match(/applyRemoteUpdate\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // 定义 1 + update 帧 1 + 重连补齐 1
  });
});
