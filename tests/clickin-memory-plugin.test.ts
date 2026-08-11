import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";

// clickin-memory 插件的确认门 + 拒绝理由链路集成测试。
// openclaw SDK import 由 vitest alias 换成身份包装替身（tests/mocks/），
// 用 fake api 捕获 hook/middleware 后直接驱动：
//   before_tool_call → requireApproval → onResolution("deny") 标记
//   → middleware 拦被拒结果 → 经真实 MCP HTTP 端点取理由 → 追加 content
// 复现并防回归 #202→#203 的这类"理由没到模型"缺陷。

process.env.MCP_PORT = "3198"; // 端点测试专用端口（模块顶层求值，import 前设）
const MCP_URL = "http://127.0.0.1:3198/mcp";

type FakeStore = {
  client: unknown;
  status: { state: string };
  connecting: null;
  events: EventEmitter;
  pendingApprovals: Map<string, { sessionKey?: string; toolCallId?: string; ts: number }>;
  denyReasons: Map<string, { reason: string; ts: number }>;
  pendingSteers: Map<string, number[]>;
};

const g = globalThis as unknown as {
  __mcpHttpServer?: { close: (cb?: () => void) => void };
  __clickinAgentGateway?: FakeStore;
};

type Handler = (event: unknown, ctx?: unknown) => unknown;
const hooks = new Map<string, Handler>();
let middleware: Handler | null = null;

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
    pendingSteers: new Map(),
  };

  // 起真实 MCP server：/deny-reason 端点 + tools/list（annotations 加载也走真请求）
  const { startMcpServer } = await import("@/lib/mcp/server");
  startMcpServer();
  await new Promise((r) => setTimeout(r, 150));

  // 加载插件，fake api 捕获注册
  const entry = (await import("../openclaw-plugins/clickin-memory/index")).default as {
    register: (api: unknown) => void;
  };
  entry.register({
    on: (name: string, handler: Handler) => {
      hooks.set(name, handler);
    },
    registerAgentToolResultMiddleware: (handler: Handler) => {
      middleware = handler;
    },
  });
});

afterAll(async () => {
  const server = g.__mcpHttpServer;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  delete g.__mcpHttpServer;
  g.__clickinAgentGateway = savedStore;
});

const PLUGIN_CONFIG = { mcpUrl: MCP_URL };

async function gateToolCall(toolCallId: string) {
  const handler = hooks.get("before_tool_call")!;
  return (await handler({
    toolName: "clickin__docs-propose",
    params: { path: "test.md", content: "x", summary: "测试" },
    toolCallId,
    context: { pluginConfig: PLUGIN_CONFIG },
  })) as { requireApproval?: { onResolution?: (d: string) => unknown } } | undefined;
}

describe("clickin-memory 确认门", () => {
  it("registers the four surfaces", () => {
    expect(hooks.has("before_tool_call")).toBe(true);
    expect(hooks.has("before_prompt_build")).toBe(true);
    expect(hooks.has("agent_end")).toBe(true);
    expect(middleware).not.toBeNull();
  });

  it("write tool gets requireApproval; read-only docs-read passes (annotations loaded live)", async () => {
    const gated = await gateToolCall("call_gate_1");
    expect(gated?.requireApproval).toBeTruthy();

    const handler = hooks.get("before_tool_call")!;
    const readResult = await handler({
      toolName: "clickin__docs-read",
      params: { path: "a.md" },
      toolCallId: "call_read_1",
      context: { pluginConfig: PLUGIN_CONFIG },
    });
    expect(readResult).toBeUndefined(); // 只读直通
  });

  it("non-clickin tools are ignored", async () => {
    const handler = hooks.get("before_tool_call")!;
    const result = await handler({
      toolName: "web_search",
      params: { query: "x" },
      toolCallId: "call_ws",
      context: { pluginConfig: PLUGIN_CONFIG },
    });
    expect(result).toBeUndefined();
  });
});

describe("拒绝理由同帧注入（mark → middleware → append）", () => {
  it("denied call with stored reason gets it appended to model-visible content", async () => {
    const toolCallId = "call_deny_1";
    // 1. 门控 + 用户拒绝（onResolution 标记）
    const gated = await gateToolCall(toolCallId);
    await gated!.requireApproval!.onResolution!("deny");

    // 2. 后端已存理由（真实链路里由 approval route 在 resolve 前写入）
    const { storeDenyReason } = await import("@/lib/agent-gateway/client");
    g.__clickinAgentGateway!.pendingApprovals.set("plugin:d1", {
      sessionKey: "agent:team:x",
      toolCallId,
      ts: Date.now(),
    });
    expect(storeDenyReason("plugin:d1", "诗太悲伤了，写欢快点")).toBe(true);

    // 3. middleware 拦截被拒结果 → 经真实 HTTP 端点取理由 → 追加
    const result = (await middleware!({
      toolCallId,
      toolName: "clickin__docs-propose",
      result: { content: [{ type: "text", text: "Denied by user" }] },
    })) as { result: { content: Array<{ type?: string; text?: string }> } };

    expect(result).toBeTruthy();
    const texts = result.result.content.map((c) => c.text).join("");
    expect(texts).toContain("Denied by user");
    expect(texts).toContain("用户拒绝理由：诗太悲伤了，写欢快点");
  });

  it("mark is consumed once — second result for same call passes untouched", async () => {
    const again = await middleware!({
      toolCallId: "call_deny_1",
      toolName: "clickin__docs-propose",
      result: { content: [{ type: "text", text: "Denied by user" }] },
    });
    expect(again).toBeUndefined();
  });

  it("denied call WITHOUT stored reason degrades to default denial (no rewrite)", async () => {
    const toolCallId = "call_deny_2";
    const gated = await gateToolCall(toolCallId);
    await gated!.requireApproval!.onResolution!("deny");

    const result = await middleware!({
      toolCallId,
      toolName: "clickin__docs-propose",
      result: { content: [{ type: "text", text: "Denied by user" }] },
    });
    expect(result).toBeUndefined();
  });

  it("allow-once resolution never marks — middleware passes result through", async () => {
    const toolCallId = "call_allow_1";
    const gated = await gateToolCall(toolCallId);
    await gated!.requireApproval!.onResolution!("allow-once");

    const result = await middleware!({
      toolCallId,
      toolName: "clickin__docs-propose",
      result: { content: [{ type: "text", text: "[stub] docs.propose → ok" }] },
    });
    expect(result).toBeUndefined();
  });
});
