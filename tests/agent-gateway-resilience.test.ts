import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { startChatRun, storeDenyReason, takeDenyReason } from "@/lib/agent-gateway/client";
import { createChatStreamResponse } from "@/lib/agent-gateway/relay";

// PR #199 的两个关键路径回归测试：
// 1. agent RPC 超时后单例连接必须被显式失效（下一次调用重连），旧连接
//    必须被 stop() 而不是裸丢引用
// 2. relay 的首个字节（ping）必须在 startRun 之前送出——RPC 挂死时
//    客户端看门狗/Cloudflare 看到的是活流而非 100 秒死寂

type FakeStore = {
  client: unknown;
  status: { state: string };
  connecting: null;
  events: EventEmitter;
  pendingApprovals: Map<string, { sessionKey?: string; toolCallId?: string; ts: number }>;
  denyReasons: Map<string, { reason: string; ts: number }>;
  steerOwners: Map<string, Set<{ pending: number }>>;
  questionSessions: Map<string, { sessionKey: string; expiresAtMs: number }>;
};

// 双重 cast 绕过 client.ts declare global 的真实类型——测试刻意注入 fake client
const g = globalThis as unknown as { __clickinAgentGateway?: FakeStore };

let savedStore: FakeStore | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  savedStore = g.__clickinAgentGateway;
  savedToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";
});

afterEach(() => {
  g.__clickinAgentGateway = savedStore;
  if (savedToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = savedToken;
});

function installFakeStore(client: unknown): FakeStore {
  const store: FakeStore = {
    client,
    status: { state: "connected" },
    connecting: null,
    events: new EventEmitter(),
    pendingApprovals: new Map(),
    denyReasons: new Map(),
    steerOwners: new Map(),
    questionSessions: new Map(),
  };
  g.__clickinAgentGateway = store;
  return store;
}

/** 假 gateway RPC：按方法名路由，覆盖 relay 收尾会走到的两条查询。 */
function fakeRpcClient(handlers: Record<string, (params?: unknown) => unknown>) {
  const calls: string[] = [];
  return {
    calls,
    request: (method: string, params?: unknown) => {
      calls.push(method);
      const handler = handlers[method];
      if (!handler) return Promise.reject(new Error(`no fake handler for ${method}`));
      try {
        return Promise.resolve(handler(params));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    stop: () => {},
  };
}

/** 读完整条 SSE 流，解出全部 data 帧。 */
async function readAllFrames(res: Response): Promise<{ type: string; [k: string]: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as { type: string });
}

describe("startChatRun timeout invalidation", () => {
  it("stops and clears the singleton on RPC failure so next call reconnects", async () => {
    let stopped = false;
    const fakeClient = {
      request: () => Promise.reject(new Error("request timed out")),
      stop: () => {
        stopped = true;
      },
    };
    const store = installFakeStore(fakeClient);

    await expect(startChatRun("clickin:chat:u:x", "hi")).rejects.toThrow("request timed out");
    expect(stopped).toBe(true);
    expect(store.client).toBeNull();
    expect(store.status.state).toBe("disconnected");
  });

  it("does not nuke a fresh connection a concurrent caller already established", async () => {
    const replacement = { request: () => Promise.resolve({}), stop: () => {} };
    let stopped = false;
    const store = installFakeStore(null);
    const dyingClient = {
      request: () =>
        new Promise((_, reject) => {
          // 模拟并发重连：请求失败前，另一个调用方已经装上了新连接
          store.client = replacement;
          reject(new Error("request timed out"));
        }),
      stop: () => {
        stopped = true;
      },
    };
    store.client = dyingClient;

    await expect(startChatRun("clickin:chat:u:x", "hi")).rejects.toThrow();
    expect(stopped).toBe(true); // 旧连接照样被显式关闭
    expect(store.client).toBe(replacement); // 新连接不受影响
    expect(store.status.state).toBe("connected");
  });
});

describe("deny reason store", () => {
  it("stores by approval id, takes once by toolCallId", () => {
    const store = installFakeStore(null);
    store.pendingApprovals.set("plugin:a1", { sessionKey: "agent:team:x", toolCallId: "call_1", ts: Date.now() });

    expect(storeDenyReason("plugin:a1", "内容不合适")).toBe(true);
    expect(takeDenyReason("call_1")).toBe("内容不合适");
    expect(takeDenyReason("call_1")).toBeUndefined(); // 一次性取走
  });

  it("returns false when approval has no toolCallId to anchor to", () => {
    const store = installFakeStore(null);
    store.pendingApprovals.set("plugin:a2", { sessionKey: "agent:team:x", ts: Date.now() });
    expect(storeDenyReason("plugin:a2", "理由")).toBe(false);
  });

  it("unknown approval id stores nothing", () => {
    installFakeStore(null);
    expect(storeDenyReason("plugin:never", "理由")).toBe(false);
    expect(takeDenyReason("call_never")).toBeUndefined();
  });
});

describe("relay first-byte ordering", () => {
  it("emits ping before startRun resolves", async () => {
    // 安静窗口到点后 relay 会去问权威状态——假 client 答"没在跑"让流走
    // chat.history 兜底快速收尾，测试不用挂 3 分钟。
    installFakeStore(
      fakeRpcClient({
        "sessions.list": () => ({ sessions: [] }),
        "chat.history": () => ({ messages: [] }),
      }),
    );

    let startRunResolved = false;
    let pingBeforeStartRun: boolean | null = null;

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "POST" });
    const res = createChatStreamResponse(req, "clickin:chat:u:test-session", {
      quietTimeoutMs: 50,
      startRun: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            startRunResolved = true;
            resolve({ runId: "r1", sessionKey: "clickin:chat:u:test-session" });
          }, 30),
        ),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (pingBeforeStartRun === null && buffer.includes('"ping"')) {
        // 首个 ping 到达的瞬间，startRun 是否还没完成
        pingBeforeStartRun = !startRunResolved;
      }
    }

    expect(pingBeforeStartRun).toBe(true);
    // SSE 帧格式：data: <json>\n\n
    const lines = buffer
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as { type: string });
    expect(lines[0].type).toBe("ping");
  });
});

describe("relay quiet-timer semantics: silence is a question, not a verdict", () => {
  const KEY = "agent:main:clickin:chat:u:quiet-session";

  it("keeps the stream open while the authority says running, then delivers the real final", async () => {
    // 长工具调用期间事件流完全静默——静默到点后 relay 必须去问 sessions.list
    // 而不是关流；权威答"running"就继续等，真正的 final 依然从流上到达。
    const rpc = fakeRpcClient({
      "sessions.list": () => ({ sessions: [{ key: KEY, status: "running" }] }),
      "chat.history": () => ({ messages: [] }),
    });
    const store = installFakeStore(rpc);

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "GET" });
    const res = createChatStreamResponse(req, KEY, { quietTimeoutMs: 50 });

    // 等 relay 至少完成一轮"到点→查询→续命"，再送真 final。
    setTimeout(() => {
      store.events.emit(`session:${KEY}`, {
        sessionKey: KEY,
        state: "final",
        message: { content: [{ type: "text", text: "长命令跑完了，这是真正的答案" }] },
      });
    }, 2500);

    const frames = await readAllFrames(res);
    const final = frames.find((f) => f.type === "final");
    expect(final).toMatchObject({ text: "长命令跑完了，这是真正的答案" });
    expect(final!.fallback).toBeUndefined(); // 真 final，不是兜底伪造的
    expect(rpc.calls.filter((m) => m === "sessions.list").length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("falls back via chat.history only after the authority says not-running, marked as fallback", async () => {
    const rpc = fakeRpcClient({
      "sessions.list": () => ({ sessions: [{ key: KEY, status: "done" }] }),
      "chat.history": () => ({
        messages: [{ role: "assistant", content: [{ type: "text", text: "历史里的完整回复" }] }],
      }),
    });
    installFakeStore(rpc);

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "GET" });
    const res = createChatStreamResponse(req, KEY, { quietTimeoutMs: 50 });

    const frames = await readAllFrames(res);
    const final = frames.find((f) => f.type === "final");
    expect(final).toMatchObject({ text: "历史里的完整回复", fallback: true });
  }, 15_000);

  it("suffix-tolerant status match: raw-key attach still finds the canonical row", async () => {
    // canonical vs raw：sessions.list 行是 canonical 形式，attach 传 raw key
    // 时 === 会静默匹配不到 → 被误判"没在跑"。必须后缀容错。
    const raw = "clickin:chat:u:suffix-session";
    const rpc = fakeRpcClient({
      "sessions.list": () => ({ sessions: [{ key: `agent:main:${raw}`, status: "running" }] }),
      "chat.history": () => ({ messages: [] }),
    });
    const store = installFakeStore(rpc);

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "GET" });
    const res = createChatStreamResponse(req, raw, { quietTimeoutMs: 50 });

    setTimeout(() => {
      store.events.emit(`session:${raw}`, {
        sessionKey: raw,
        state: "final",
        message: { content: [{ type: "text", text: "ok" }] },
      });
    }, 2500);

    const frames = await readAllFrames(res);
    const final = frames.find((f) => f.type === "final");
    // 若后缀匹配失效，权威查询会答 not-running，流早在 final 前就被兜底关闭
    expect(final).toMatchObject({ text: "ok" });
    expect(final!.fallback).toBeUndefined();
  }, 15_000);

  it("forwards question frames and dedups identical replace snapshots", async () => {
    const rpc = fakeRpcClient({
      "sessions.list": () => ({ sessions: [{ key: KEY, status: "done" }] }),
      "chat.history": () => ({ messages: [] }),
    });
    const store = installFakeStore(rpc);

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "GET" });
    const res = createChatStreamResponse(req, KEY, { quietTimeoutMs: 3_000 });

    setTimeout(() => {
      // gateway 实测会在一秒内重发同一句话的全量快照 30+ 次——同文本快照
      // 只应下发一帧
      for (let i = 0; i < 5; i++) {
        store.events.emit(`session:${KEY}`, {
          sessionKey: KEY,
          stream: "assistant",
          data: { text: "同一句话", delta: "" },
        });
      }
      // ask_user 问题卡片走独立的 question.* 通道，relay 必须原样转发
      store.events.emit(`session:${KEY}`, {
        questionRequested: {
          id: "q-9",
          questions: [{ questionId: "go", header: "确认", question: "继续吗?", options: [{ label: "是" }] }],
          status: "pending",
        },
      });
      store.events.emit(`session:${KEY}`, { questionResolved: { id: "q-9", status: "answered" } });
      store.events.emit(`session:${KEY}`, {
        sessionKey: KEY,
        state: "final",
        message: { content: [{ type: "text", text: "收尾" }] },
      });
    }, 1200);

    const frames = await readAllFrames(res);
    expect(frames.filter((f) => f.type === "delta" && f.text === "同一句话")).toHaveLength(1);
    expect(frames.find((f) => f.type === "question")).toMatchObject({ question: { id: "q-9" } });
    expect(frames.find((f) => f.type === "question-resolved")).toMatchObject({ id: "q-9", status: "answered" });
  }, 15_000);

  it("delta-only restatement after a cumulative snapshot does not double the text", async () => {
    // Gateway 实测把同一段文本以两种形态各发一遍：replace:true/text:X 与
    // delta:X。对后者做 += 就是双份文本——快照在场时裸增量必须被忽略
    // （协议每个事件都带累计 text，真增量会以下一个快照到达，不会丢字）。
    const rpc = fakeRpcClient({
      "sessions.list": () => ({ sessions: [{ key: KEY, status: "done" }] }),
      "chat.history": () => ({ messages: [] }),
    });
    const store = installFakeStore(rpc);

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "GET" });
    const res = createChatStreamResponse(req, KEY, { quietTimeoutMs: 3_000 });

    setTimeout(() => {
      store.events.emit(`session:${KEY}`, {
        sessionKey: KEY,
        stream: "assistant",
        data: { replace: true, delta: "", text: "命令已在跑" },
      });
      store.events.emit(`session:${KEY}`, {
        sessionKey: KEY,
        stream: "assistant",
        data: { delta: "命令已在跑" }, // 同段文本的第二形态：裸增量重述
      });
      store.events.emit(`session:${KEY}`, {
        sessionKey: KEY,
        state: "final",
        message: { content: [{ type: "text", text: "命令已在跑" }] },
      });
    }, 1200);

    const frames = await readAllFrames(res);
    const deltas = frames.filter((f) => f.type === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].text).toBe("命令已在跑");
    expect(frames.find((f) => f.type === "final")).toMatchObject({ text: "命令已在跑" }); // 不是"命令已在跑命令已在跑"
  }, 15_000);

  it("pure delta-only increments (no snapshot ever) still accumulate", async () => {
    const rpc = fakeRpcClient({
      "sessions.list": () => ({ sessions: [{ key: KEY, status: "done" }] }),
      "chat.history": () => ({ messages: [] }),
    });
    const store = installFakeStore(rpc);

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "GET" });
    const res = createChatStreamResponse(req, KEY, { quietTimeoutMs: 3_000 });

    setTimeout(() => {
      store.events.emit(`session:${KEY}`, { sessionKey: KEY, stream: "assistant", data: { delta: "你" } });
      store.events.emit(`session:${KEY}`, { sessionKey: KEY, stream: "assistant", data: { delta: "好" } });
      store.events.emit(`session:${KEY}`, {
        sessionKey: KEY,
        state: "final",
        message: { content: [{ type: "text", text: "你好" }] },
      });
    }, 1200);

    const frames = await readAllFrames(res);
    expect(frames.filter((f) => f.type === "delta").map((f) => f.text)).toEqual(["你", "你好"]);
    expect(frames.find((f) => f.type === "final")).toMatchObject({ text: "你好" });
  }, 15_000);
});
