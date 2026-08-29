import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, StreamFn } from "../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, setProductionTier, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createNewSessionKey } from "@/lib/mcp/session-identity";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-chat/stream-reducer";
import { runtimeOverrides, waitForIdle } from "@/lib/agent-runtime/service";
import { CHAT_MODEL } from "@/lib/agent-runtime/config";
import { createApproval } from "@/lib/agent-runtime/approvals";
import { createOrReuseQuestion } from "@/lib/agent-runtime/questions";
import { newApprovalId, newQuestionId, newRunId, newSessionId } from "@/lib/agent-runtime/ids";

// #367 S2：路由分流的端到端——AGENT_RUNTIME=runner 时，同一套路由（stream/history/
// sessions/abort/[key]）走自建运行时；SSE 帧格式与行协议与网关时代一致，前端零改动。
// 用 Next 路由处理器直接调用（同 tests/agent-stream-route.test.ts 的做法）。

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function textStream(text: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const final: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: CHAT_MODEL.api, provider: CHAT_MODEL.provider, model: CHAT_MODEL.id, usage: USAGE, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...final, content: [] } });
      stream.push({ type: "done", reason: "stop", message: final });
    });
    return stream;
  };
}

async function readSse(res: Response): Promise<StreamLine[]> {
  const text = await res.text();
  return text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)) as StreamLine);
}

describe("agent routes（自建运行时）", () => {
  let userId: string;
  let prodId: string;
  let cookie: string;
  const keys: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-routes-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro"); // 项目档位门（#280）：AI 功能在 pro 档
    cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试用户", avatarUrl: null, isAdmin: false })}`;
    runtimeOverrides.apiKey = "test-key";
  });

  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.apiKey;
    for (const k of keys) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [k]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  function req(url: string, init?: { method?: string; body?: string }): NextRequest {
    return new NextRequest(new URL(url, "http://localhost"), {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: { cookie, "content-type": "application/json" },
    });
  }

  it("POST /chat/stream：SSE 帧 data: <json>，ping → session → delta… → final；历史与列表随之可查", async () => {
    runtimeOverrides.streamFn = textStream("你好呀");
    const key = createNewSessionKey(userId, prodId);
    keys.push(key);
    const { POST } = await import("@/app/api/agent/chat/stream/route");
    const res = await POST(req("/api/agent/chat/stream", { method: "POST", body: JSON.stringify({ sessionKey: key, message: "你好" }) }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const lines = await readSse(res);
    expect(lines[0]).toEqual({ type: "ping" });
    expect(lines.find((l) => l.type === "session")).toMatchObject({ type: "session", key });
    expect(lines[lines.length - 1]).toEqual({ type: "final", text: "你好呀" });
    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    expect(bubbles).toEqual([{ kind: "assistant", text: "你好呀" }]);
    await waitForIdle(key);

    const { GET: history } = await import("@/app/api/agent/chat/history/route");
    const h = await history(req(`/api/agent/chat/history?sessionKey=${encodeURIComponent(key)}`));
    expect((await h.json()).messages).toEqual([{ role: "user", content: "你好" }, { role: "assistant", content: "你好呀" }]);

    const { GET: list } = await import("@/app/api/agent/sessions/route");
    const l = await (await list(req("/api/agent/sessions"))).json();
    expect(l.gatewayStatus).toEqual({ state: "connected" }); // runner 模式不报网关横幅
    expect(l.sessions.find((s: { key: string }) => s.key === key)).toMatchObject({ title: "你好", status: "done" });
  });

  it("所有权：他人的 sessionKey 被 403，不泄露存在性", async () => {
    const { POST } = await import("@/app/api/agent/chat/stream/route");
    const foreign = createNewSessionKey("99999999-9999-9999-9999-999999999999");
    const res = await POST(req("/api/agent/chat/stream", { method: "POST", body: JSON.stringify({ sessionKey: foreign, message: "x" }) }));
    expect(res.status).toBe(403);
  });

  it("PATCH/DELETE /sessions/[key]：改名落 agent_session.title，删除级联清 transcript", async () => {
    runtimeOverrides.streamFn = textStream("ok");
    const key = createNewSessionKey(userId);
    keys.push(key);
    const { POST } = await import("@/app/api/agent/chat/stream/route");
    await readSse(await POST(req("/api/agent/chat/stream", { method: "POST", body: JSON.stringify({ sessionKey: key, message: "hi" }) })));
    await waitForIdle(key);

    const { PATCH, DELETE } = await import("@/app/api/agent/sessions/[key]/route");
    const params = Promise.resolve({ key });
    await PATCH(req(`/api/agent/sessions/${key}`, { method: "PATCH", body: JSON.stringify({ title: "改过的标题" }) }), { params });
    expect((await getPool().query<{ title: string }>(`SELECT title FROM agent_session WHERE id = $1`, [key])).rows[0].title).toBe("改过的标题");
    await DELETE(req(`/api/agent/sessions/${key}`, { method: "DELETE" }), { params });
    expect((await getPool().query(`SELECT 1 FROM agent_session_entry WHERE session_id = $1`, [key])).rowCount).toBe(0);
  });

  it("steer 于已结束的 run → 409（不再有进行中的回复）", async () => {
    runtimeOverrides.streamFn = textStream("done");
    const key = createNewSessionKey(userId, prodId);
    keys.push(key);
    const { POST } = await import("@/app/api/agent/chat/stream/route");
    await readSse(await POST(req("/api/agent/chat/stream", { method: "POST", body: JSON.stringify({ sessionKey: key, message: "a" }) })));
    await waitForIdle(key);
    const res = await POST(req("/api/agent/chat/stream", { method: "POST", body: JSON.stringify({ sessionKey: key, message: "b", steer: true }) }));
    expect(res.status).toBe(409);
  });
});

// AI review #371：ap_/aq_ 前缀是路由分流（网关 vs 自建）的契约，且 runner 分支的路由层
// 此前没有测试（所有权 + 成功路径）。审批/提问的行由 run 服务在工具门里创建，这里直接
// 用同一函数造行，绕开模型。
describe("agent approval/questions routes：runner 分支（ap_/aq_）", () => {
  let userId: string;
  let strangerId: string;
  let prodId: string;
  let cookie: string;
  let strangerCookie: string;
  let key: string;
  let runId: string;

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-gate-${shortId()}`, null, false));
    ({ userId: strangerId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-stranger-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro");
    cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "主人", avatarUrl: null, isAdmin: false })}`;
    strangerCookie = `${SESSION_COOKIE}=${createSession({ userId: strangerId, name: "路人", avatarUrl: null, isAdmin: false })}`;
    runtimeOverrides.apiKey = "test-key";
    runtimeOverrides.streamFn = textStream("ok");
    // 一轮真实 run：产生 agent_session + agent_run（审批/提问表 FK 到 run）
    key = createNewSessionKey(userId, prodId);
    const { POST } = await import("@/app/api/agent/chat/stream/route");
    await readSse(await POST(new NextRequest(new URL("/api/agent/chat/stream", "http://localhost"), {
      method: "POST", body: JSON.stringify({ sessionKey: key, message: "hi" }), headers: { cookie, "content-type": "application/json" },
    })));
    await waitForIdle(key);
    runId = (await getPool().query<{ id: string }>(`SELECT id FROM agent_run WHERE session_id = $1`, [key])).rows[0].id;
  });

  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.apiKey;
    await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [key]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  function post(url: string, body: unknown, c = cookie): NextRequest {
    return new NextRequest(new URL(url, "http://localhost"), { method: "POST", body: JSON.stringify(body), headers: { cookie: c, "content-type": "application/json" } });
  }

  it("id 前缀契约：自建运行时的 id 一定以 ap_/aq_（及 as_/ar_）开头——路由靠它分流，网关 id 不得撞上", () => {
    expect(newApprovalId()).toMatch(/^ap_[0-9a-z]+$/);
    expect(newQuestionId()).toMatch(/^aq_[0-9a-z]+$/);
    expect(newSessionId()).toMatch(/^as_/);
    expect(newRunId()).toMatch(/^ar_/);
  });

  it("POST /approval：路人 403 / 伪造 ap_ id 403（不泄露存在性）/ 主人 deny 带理由落库", async () => {
    const { POST } = await import("@/app/api/agent/approval/route");
    const { id } = await createApproval({
      runId, sessionId: key, toolCallId: `c_${shortId()}`, tool: "clickin__production-wiki_propose_create", args: { title: "x" },
      card: { title: "新建文档", description: "将新建一篇文档", severity: "warning" },
    });
    expect(id.startsWith("ap_")).toBe(true);

    expect((await POST(post("/api/agent/approval", { id, decision: "allow-once" }, strangerCookie))).status).toBe(403);
    expect((await POST(post("/api/agent/approval", { id: "ap_doesnotexist", decision: "allow-once" }))).status).toBe(403);
    expect((await POST(post("/api/agent/approval", { id, decision: "maybe" }))).status).toBe(400); // decision 校验在分流之前

    const ok = await POST(post("/api/agent/approval", { id, decision: "deny", reason: "先别建" }));
    expect(ok.status).toBe(200);
    const row = (await getPool().query(`SELECT status, decision, reason, resolved_by FROM agent_approval WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "denied", decision: "deny", reason: "先别建", resolved_by: userId });
    // 已决议的不能再决议
    expect((await POST(post("/api/agent/approval", { id, decision: "allow-once" }))).status).toBe(403);
  });

  it("GET/POST /questions：runner 会话的待答列表；路人与伪造 aq_ id 统一 404；主人回答后落表", async () => {
    const { GET, POST } = await import("@/app/api/agent/questions/route");
    const q = await createOrReuseQuestion({
      runId, sessionId: key, toolCallId: `c_${shortId()}`,
      questions: [{ questionId: "q1", header: "场地", question: "这次排练在哪？", options: [{ label: "A 厅", description: "" }, { label: "B 厅", description: "" }] }],
    });
    expect(q.id.startsWith("aq_")).toBe(true);

    const list = await GET(new NextRequest(new URL(`/api/agent/questions?sessionKey=${encodeURIComponent(key)}`, "http://localhost"), { headers: { cookie } }));
    expect((await list.json()).questions.map((x: { id: string }) => x.id)).toContain(q.id);

    expect((await POST(post("/api/agent/questions", { id: q.id, answers: { q1: ["A 厅"] } }, strangerCookie))).status).toBe(404);
    expect((await POST(post("/api/agent/questions", { id: "aq_doesnotexist", answers: { q1: ["A 厅"] } }))).status).toBe(404);

    const ok = await POST(post("/api/agent/questions", { id: q.id, answers: { q1: "A 厅" } })); // 单值也规整成数组
    expect(ok.status).toBe(200);
    const row = (await getPool().query(`SELECT status, answer FROM agent_question WHERE id = $1`, [q.id])).rows[0];
    expect(row.status).toBe("answered");
    expect(row.answer).toEqual({ q1: ["A 厅"] });
    expect((await POST(post("/api/agent/questions", { id: q.id, answers: { q1: ["B 厅"] } }))).status).toBe(404); // 已答不能再答
  });
});
