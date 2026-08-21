import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";

// /deny-reason 端点的真 HTTP 测试：起真实 MCP server（测试专用端口，
// MCP_PORT 必须在模块 import 之前设好——端口在模块顶层求值）。

process.env.MCP_PORT = "3197";
const BASE = "http://127.0.0.1:3197";

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

const g = globalThis as unknown as {
  __mcpHttpServer?: { close: (cb?: () => void) => void };
  __clickinAgentGateway?: FakeStore;
};

let savedStore: FakeStore | undefined;

beforeAll(async () => {
  savedStore = g.__clickinAgentGateway;
  g.__clickinAgentGateway = {
    client: null,
    status: { state: "connected" },
    connecting: null,
    events: new EventEmitter(),
    pendingApprovals: new Map(),
    denyReasons: new Map(),
    steerOwners: new Map(), questionSessions: new Map(),
  };
  const { startMcpServer } = await import("@/lib/mcp/server");
  startMcpServer();
  // 等 listen 完成
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(async () => {
  const server = g.__mcpHttpServer;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  delete g.__mcpHttpServer;
  g.__clickinAgentGateway = savedStore;
});

describe("GET /deny-reason", () => {
  it("missing toolCallId → 400", async () => {
    const res = await fetch(`${BASE}/deny-reason`);
    expect(res.status).toBe(400);
  });

  it("unknown toolCallId → reason null", async () => {
    const res = await fetch(`${BASE}/deny-reason?toolCallId=call_unknown`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reason: null });
  });

  it("stored reason is returned once, then null (one-time take)", async () => {
    const { storeDenyReason } = await import("@/lib/agent-gateway/client");
    g.__clickinAgentGateway!.pendingApprovals.set("plugin:t1", {
      sessionKey: "agent:team:x",
      toolCallId: "call_t1",
      ts: Date.now(),
    });
    expect(storeDenyReason("plugin:t1", "诗太悲伤了")).toBe(true);

    const first = await fetch(`${BASE}/deny-reason?toolCallId=call_t1`);
    expect(await first.json()).toEqual({ reason: "诗太悲伤了" });

    const second = await fetch(`${BASE}/deny-reason?toolCallId=call_t1`);
    expect(await second.json()).toEqual({ reason: null });
  });
});
