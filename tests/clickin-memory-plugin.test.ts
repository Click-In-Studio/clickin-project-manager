import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";

// clickin-memory 插件的确认门 + 拒绝理由链路集成测试。
// openclaw SDK import 由 vitest alias 换成身份包装替身（tests/mocks/），
// 用 fake api 捕获 hook/middleware 后直接驱动：
//   before_tool_call → requireApproval → onResolution("deny") 标记
//   → middleware 拦被拒结果 → 经真实 MCP HTTP 端点取理由 → 追加 content
// 复现并防回归 #202→#203 的这类"理由没到模型"缺陷。
//
// docs.read/docs.propose 已随 wiki 工具组退役——通用门控机制测试改用
// production.wiki_backlinks（只读）/production.wiki_propose_create（写）打靶，
// 语义等价（前者路径参数换成 wikiId，后者是四个 propose 写工具之一，
// update/delete/move 三个兄弟的专属覆盖见下面的 describe 块）。

process.env.MCP_PORT = "3198"; // 端点测试专用端口（模块顶层求值，import 前设）
const MCP_URL = "http://127.0.0.1:3198/mcp";

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
    steerOwners: new Map(), questionSessions: new Map(),
  };

  // 起真实 MCP server：/deny-reason、/wiki-proposal 端点 + tools/list（annotations 加载也走真请求）
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
const CALLER_ID = "0b6ab930-e2aa-4020-8334-d749d7be82a5";
const SESSION_CTX = { sessionKey: `agent:team:clickin:chat:${CALLER_ID}:11111111-2222-3333-4444-555555555555` };

async function gateToolCall(toolCallId: string) {
  const handler = hooks.get("before_tool_call")!;
  return (await handler(
    {
      toolName: "clickin__production-wiki_propose_create",
      params: { title: "测试文档", body: "正文", summary: "测试" },
      toolCallId,
      context: { pluginConfig: PLUGIN_CONFIG },
    },
    SESSION_CTX,
  )) as
    | { params?: Record<string, unknown>; requireApproval?: { severity?: string; description?: string; onResolution?: (d: string) => unknown } }
    | undefined;
}

describe("clickin-memory 确认门", () => {
  it("registers the four surfaces", () => {
    expect(hooks.has("before_tool_call")).toBe(true);
    expect(hooks.has("before_prompt_build")).toBe(true);
    expect(hooks.has("agent_end")).toBe(true);
    expect(middleware).not.toBeNull();
  });

  it("write tool gets requireApproval WITH caller-id param override", async () => {
    const gated = await gateToolCall("call_gate_1");
    expect(gated?.requireApproval).toBeTruthy();
    expect(gated?.params?._caller_user_id).toBe(CALLER_ID);
  });

  it("write tool also gets _tool_call_id param override (wiki_propose 回填 proposal 行要用)", async () => {
    const gated = await gateToolCall("call_gate_tcid");
    expect(gated?.params?._tool_call_id).toBe("call_gate_tcid");
  });

  it("read-only production.wiki_backlinks passes with caller-id injected (annotations loaded live)", async () => {
    const handler = hooks.get("before_tool_call")!;
    const readResult = (await handler(
      {
        toolName: "clickin__production-wiki_backlinks",
        params: { wikiId: "some-wiki-id" },
        toolCallId: "call_read_1",
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      SESSION_CTX,
    )) as { params?: Record<string, unknown>; requireApproval?: unknown };
    expect(readResult?.requireApproval).toBeUndefined(); // 只读不弹卡
    expect(readResult?.params?._caller_user_id).toBe(CALLER_ID); // 但身份已注入
    expect(readResult?.params?.wikiId).toBe("some-wiki-id"); // 原参数保留
  });

  it("model-forged _caller_user_id is overwritten by the real session identity", async () => {
    const handler = hooks.get("before_tool_call")!;
    const result = (await handler(
      {
        toolName: "clickin__production-wiki_backlinks",
        params: { wikiId: "x", _caller_user_id: "99999999-9999-9999-9999-999999999999" },
        toolCallId: "call_forge",
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      SESSION_CTX,
    )) as { params?: Record<string, unknown> };
    expect(result?.params?._caller_user_id).toBe(CALLER_ID); // 伪造被盖掉
  });

  it("production session injects _caller_production_id; personal session strips forged one", async () => {
    const handler = hooks.get("before_tool_call")!;
    const prodCtx = { sessionKey: `agent:team:clickin:chat:${CALLER_ID}:t3k9xa1b:11111111-2222-3333-4444-555555555555` };
    const prodResult = (await handler(
      { toolName: "clickin__production-wiki_backlinks", params: { wikiId: "x" }, toolCallId: "call_prod", context: { pluginConfig: PLUGIN_CONFIG } },
      prodCtx,
    )) as { params?: Record<string, unknown> };
    expect(prodResult?.params?._caller_user_id).toBe(CALLER_ID);
    expect(prodResult?.params?._caller_production_id).toBe("t3k9xa1b");

    const personal = (await handler(
      {
        toolName: "clickin__production-wiki_backlinks",
        params: { wikiId: "x", _caller_production_id: "forged123" },
        toolCallId: "call_personal",
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      SESSION_CTX, // 个人会话
    )) as { params?: Record<string, unknown> };
    expect(personal?.params?._caller_user_id).toBe(CALLER_ID);
    expect(personal?.params?._caller_production_id).toBeUndefined(); // 伪造被剥除
  });

  it("non-webchat session (no identity) strips any forged caller id", async () => {
    const handler = hooks.get("before_tool_call")!;
    const result = (await handler(
      {
        toolName: "clickin__production-wiki_backlinks",
        params: { wikiId: "x", _caller_user_id: "99999999-9999-9999-9999-999999999999" },
        toolCallId: "call_cron",
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      { sessionKey: "agent:team:cron:job-xyz" },
    )) as { params?: Record<string, unknown> };
    expect(result?.params?._caller_user_id).toBeUndefined(); // 无身份则剥除
  });

  it("non-clickin tools are ignored entirely", async () => {
    const handler = hooks.get("before_tool_call")!;
    const result = await handler(
      {
        toolName: "web_search",
        params: { query: "x" },
        toolCallId: "call_ws",
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      SESSION_CTX,
    );
    expect(result).toBeUndefined();
  });
});

describe("wiki_propose 确认卡片：权限状态预持久化（工具调用权限门原则）", () => {
  let prodId: string;
  let ownerId: string;
  let plainMemberId: string;

  beforeAll(async () => {
    ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `插件测试所有者${shortId()}`, null, false)).userId;
    plainMemberId = (await upsertFeishuUser(`test-open-${shortId()}`, `插件测试零权限成员${shortId()}`, null, false)).userId;
    ({ prodId } = await makeProduction(ownerId));
    await addProductionMember(prodId, plainMemberId);
  });

  afterAll(async () => {
    await cleanupProduction(prodId).catch(() => {});
  });

  function prodSessionCtx(userId: string) {
    return { sessionKey: `agent:team:clickin:chat:${userId}:${prodId}:11111111-2222-3333-4444-555555555555` };
  }

  it("有权限的调用者 → 确认卡片 severity=warning，description 带正向权限提示", async () => {
    const handler = hooks.get("before_tool_call")!;
    const gated = (await handler(
      {
        toolName: "clickin__production-wiki_propose_create",
        params: { title: "插件测试文档", body: "正文", summary: "摘要" },
        toolCallId: `call_${shortId()}`,
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      prodSessionCtx(ownerId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(gated?.requireApproval?.severity).toBe("warning");
    expect(gated?.requireApproval?.description).toContain("✅");
  });

  it("无权限的调用者 → 确认卡片 severity=critical，description 明确提示没有权限", async () => {
    const handler = hooks.get("before_tool_call")!;
    const gated = (await handler(
      {
        toolName: "clickin__production-wiki_propose_create",
        params: { title: "不该被建的文档", body: "", summary: "摘要" },
        toolCallId: `call_${shortId()}`,
        context: { pluginConfig: PLUGIN_CONFIG },
      },
      prodSessionCtx(plainMemberId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(gated?.requireApproval?.severity).toBe("critical");
    expect(gated?.requireApproval?.description).toContain("⛔");
  });

  it("个人会话（无 productionId）→ 不打预持久化端点，仍照旧走确认门（不虚构权限状态）", async () => {
    const gated = await gateToolCall(`call_${shortId()}`);
    expect(gated?.requireApproval).toBeTruthy();
    expect(gated?.requireApproval?.severity).toBe("warning"); // undefined → 不判定 critical
    expect(gated?.requireApproval?.description).not.toContain("✅");
    expect(gated?.requireApproval?.description).not.toContain("⛔");
  });

  it("wiki_propose_tag 同样按 hasPermission 出 severity，description 带标签列表", async () => {
    const { createWiki } = await import("@/lib/wiki-db");
    const doc = await createWiki({ productionId: prodId, title: "插件测试标签目标文档", createdBy: ownerId });
    const handler = hooks.get("before_tool_call")!;

    const tagGated = (await handler(
      { toolName: "clickin__production-wiki_propose_tag", params: { wikiId: doc.id, tags: ["剧本", "重要"], summary: "" }, toolCallId: `call_${shortId()}`, context: { pluginConfig: PLUGIN_CONFIG } },
      prodSessionCtx(ownerId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(tagGated?.requireApproval?.severity).toBe("warning");
    expect(tagGated?.requireApproval?.description).toContain("✅");
    expect(tagGated?.requireApproval?.description).toContain("剧本、重要");

    const tagGatedNoPerm = (await handler(
      { toolName: "clickin__production-wiki_propose_tag", params: { wikiId: doc.id, tags: [], summary: "" }, toolCallId: `call_${shortId()}`, context: { pluginConfig: PLUGIN_CONFIG } },
      prodSessionCtx(plainMemberId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(tagGatedNoPerm?.requireApproval?.severity).toBe("critical");
    expect(tagGatedNoPerm?.requireApproval?.description).toContain("⛔");
    expect(tagGatedNoPerm?.requireApproval?.description).toContain("（清空）");
  });

  it("wiki_propose_update/_delete/_move 三兄弟同样按 hasPermission 出 severity（实例级门，不是 create 的域级门）", async () => {
    const { createWiki } = await import("@/lib/wiki-db");
    const doc = await createWiki({ productionId: prodId, title: "插件测试目标文档", createdBy: ownerId });
    const handler = hooks.get("before_tool_call")!;

    const updateGated = (await handler(
      { toolName: "clickin__production-wiki_propose_update", params: { wikiId: doc.id, title: "改标题", summary: "" }, toolCallId: `call_${shortId()}`, context: { pluginConfig: PLUGIN_CONFIG } },
      prodSessionCtx(ownerId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(updateGated?.requireApproval?.severity).toBe("warning");
    expect(updateGated?.requireApproval?.description).toContain("✅");

    const deleteGatedNoPerm = (await handler(
      { toolName: "clickin__production-wiki_propose_delete", params: { wikiId: doc.id, summary: "" }, toolCallId: `call_${shortId()}`, context: { pluginConfig: PLUGIN_CONFIG } },
      prodSessionCtx(plainMemberId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(deleteGatedNoPerm?.requireApproval?.severity).toBe("critical");
    expect(deleteGatedNoPerm?.requireApproval?.description).toContain("⛔");

    const moveGated = (await handler(
      { toolName: "clickin__production-wiki_propose_move", params: { wikiId: doc.id, summary: "" }, toolCallId: `call_${shortId()}`, context: { pluginConfig: PLUGIN_CONFIG } },
      prodSessionCtx(ownerId),
    )) as { requireApproval?: { severity?: string; description?: string } };
    expect(moveGated?.requireApproval?.severity).toBe("warning");
    expect(moveGated?.requireApproval?.description).toContain("✅");
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
      toolName: "clickin__production-wiki_propose_create",
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
      toolName: "clickin__production-wiki_propose_create",
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
      toolName: "clickin__production-wiki_propose_create",
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
      toolName: "clickin__production-wiki_propose_create",
      result: { content: [{ type: "text", text: "已创建文档" }] },
    });
    expect(result).toBeUndefined();
  });
});

describe("before_prompt_build：指令/记忆双包裹（经真实 /inject-context 端到端）", () => {
  // 两个包裹语义相反（instructions 须遵守 / memory 仅参考），指令落进
  // 「非指令」包裹会被消解——这里穿真实 MCP 端点 + 真 DB 验证拆分。
  it("user with personal instructions gets BOTH wrappers, instructions first", async () => {
    const { userId } = await upsertFeishuUser(`test-open-${shortId()}`, `注入测试-${shortId()}`, null, false);
    const { setAgentInstructions } = await import("@/lib/agent-instructions");
    await setAgentInstructions("user", userId, "回复永远带一句押韵的话。", userId);
    try {
      const handler = hooks.get("before_prompt_build")!;
      const out = (await handler(
        { context: { pluginConfig: PLUGIN_CONFIG } },
        { sessionKey: `agent:team:clickin:chat:${userId}:11111111-2222-3333-4444-555555555555` },
      )) as { appendSystemContext?: string } | undefined;
      const ctx = out?.appendSystemContext ?? "";
      expect(ctx).toContain("<clickin-instructions>");
      expect(ctx).toContain("回复永远带一句押韵的话。");
      expect(ctx).toContain("<clickin-memory>");
      // 指令块在记忆块之前，且指令内容不落进记忆包裹
      expect(ctx.indexOf("<clickin-instructions>")).toBeLessThan(ctx.indexOf("<clickin-memory>"));
      expect(ctx.indexOf("回复永远带一句押韵的话。")).toBeLessThan(ctx.indexOf("<clickin-memory>"));
    } finally {
      const { getPool } = await import("@/lib/pg");
      await getPool().query(`DELETE FROM agent_instructions WHERE scope_id = $1`, [userId]);
    }
  });

  it("user without instructions gets ONLY the memory wrapper", async () => {
    const { userId } = await upsertFeishuUser(`test-open-${shortId()}`, `无指令注入-${shortId()}`, null, false);
    const handler = hooks.get("before_prompt_build")!;
    const out = (await handler(
      { context: { pluginConfig: PLUGIN_CONFIG } },
      { sessionKey: `agent:team:clickin:chat:${userId}:11111111-2222-3333-4444-555555555555` },
    )) as { appendSystemContext?: string } | undefined;
    const ctx = out?.appendSystemContext ?? "";
    expect(ctx).not.toContain("<clickin-instructions>");
    expect(ctx).toContain("<clickin-memory>");
  });
});
