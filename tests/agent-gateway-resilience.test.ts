import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { startChatRun } from "@/lib/agent-gateway/client";
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
  pendingApprovals: Map<string, { sessionKey?: string; ts: number }>;
  pendingSteers: Map<string, number[]>;
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
    pendingSteers: new Map(),
  };
  g.__clickinAgentGateway = store;
  return store;
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

describe("relay first-byte ordering", () => {
  it("emits ping before startRun resolves", async () => {
    installFakeStore(null); // subscribeToSession 只用 events，不需要连接

    let startRunResolved = false;
    let pingBeforeStartRun: boolean | null = null;

    const req = new NextRequest("http://localhost/api/agent/chat/stream", { method: "POST" });
    const res = createChatStreamResponse(req, "clickin:chat:u:test-session", {
      overallTimeoutMs: 50, // 快速走到收尾，避免测试挂 3 分钟
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
    const lines = buffer.trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(lines[0].type).toBe("ping");
  });
});
