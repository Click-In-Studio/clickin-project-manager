import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, StreamFn } from "../vendor/openclaw/packages/llm-core/src/types.js";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, setProductionTier, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createNewSessionKey } from "@/lib/agent-gateway/client";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-gateway/stream-reducer";
import { runtimeOverrides, waitForIdle } from "@/lib/agent-runtime/service";
import { CHAT_MODEL } from "@/lib/agent-runtime/config";

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

describe("agent routes under AGENT_RUNTIME=runner", () => {
  let userId: string;
  let prodId: string;
  let cookie: string;
  const keys: string[] = [];
  const prevRuntime = process.env.AGENT_RUNTIME;

  beforeAll(async () => {
    process.env.AGENT_RUNTIME = "runner";
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-routes-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro"); // 项目档位门（#280）：AI 功能在 pro 档
    cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试用户", avatarUrl: null, isAdmin: false })}`;
    runtimeOverrides.apiKey = "test-key";
  });

  afterAll(async () => {
    process.env.AGENT_RUNTIME = prevRuntime;
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.apiKey;
    for (const k of keys) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [k]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  function req(url: string, init?: RequestInit): NextRequest {
    return new NextRequest(new URL(url, "http://localhost"), { ...init, headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) } });
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
