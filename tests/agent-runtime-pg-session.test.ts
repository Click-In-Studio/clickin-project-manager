import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Model, StreamFn, ToolCall } from "../vendor/openclaw/packages/llm-core/src/types";
import { CoreAgentHarness, type ExecutionEnv } from "../vendor/openclaw/packages/agent-core/src/index";
import { Session } from "../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { PgSessionStorage } from "@/lib/agent-runtime/pg-session-storage";
import { newSessionId } from "@/lib/agent-runtime/ids";
import { repairAndClassify, type RuntimeTool } from "@/lib/agent-runtime/resume";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";

// #367 S2：Postgres 会话树存储。真 DB + 假模型 + 真 harness：
//   ① 会话与 user/production 的关联是一等列
//   ② 每条 message_end 即落行（步进持久化），行序 = seq
//   ③ 进程"死掉"后（丢掉内存对象）从 DB 重新装载，续跑（判据⑤ 的 PG 版）
//   ④ 唯一约束防双写

const MODEL: Model = {
  id: "fake", name: "fake", api: "openai-completions", provider: "deepseek", baseUrl: "https://example.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
};
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = () => ({ role: "assistant" as const, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, timestamp: Date.now() });

function scriptedStream(script: Array<{ text: string } | { calls: ToolCall[] }>): StreamFn {
  return () => {
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const final: AssistantMessage = "text" in next
        ? { ...base(), content: [{ type: "text", text: next.text }], stopReason: "stop" }
        : { ...base(), content: next.calls, stopReason: "toolUse" };
      stream.push({ type: "start", partial: { ...final, content: [] } });
      stream.push({ type: "done", reason: final.stopReason as "stop" | "toolUse", message: final });
    });
    return stream;
  };
}

const echo: RuntimeTool = {
  name: "echo", label: "Echo", description: "回显", readOnly: true, parameters: Type.Object({ q: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: `echoed ${(p as { q: string }).q}` }], details: undefined }),
};

function harnessFor(storage: PgSessionStorage, streamFn: StreamFn) {
  return new CoreAgentHarness({
    env: {} as ExecutionEnv, session: new Session(storage), tools: [echo], model: MODEL, systemPrompt: "t",
    runtime: { streamSimple: streamFn, completeSimple: async () => { throw new Error("unused"); } },
  });
}

describe("PgSessionStorage", () => {
  let userId: string;
  let prodId: string;
  const createdSessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-pg-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
  });

  afterAll(async () => {
    const pool = getPool();
    for (const id of createdSessions) await pool.query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  async function newStorage(productionId: string | null) {
    const id = newSessionId();
    createdSessions.push(id);
    return PgSessionStorage.create({ id, userId, productionId, title: "测试会话" });
  }

  it("① 会话行带 user/production 关联；个人会话 production_id 为 NULL", async () => {
    const prod = await newStorage(prodId);
    const personal = await newStorage(null);
    const rows = await getPool().query<{ id: string; user_id: string; production_id: string | null }>(
      `SELECT id, user_id, production_id FROM agent_session WHERE id = ANY($1::text[]) ORDER BY id`,
      [[(await prod.getMetadata()).id, (await personal.getMetadata()).id]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) expect(r.user_id).toBe(userId);
    expect(rows.rows.map((r) => r.production_id).sort()).toEqual([null, prodId].sort());
    expect((await prod.getMetadata()).productionId).toBe(prodId);
  });

  it("② 一轮 prompt 逐条落行，seq 单调，payload 是完整 SessionTreeEntry；重新装载后树一致", async () => {
    const storage = await newStorage(prodId);
    const sessionId = (await storage.getMetadata()).id;
    const call: ToolCall = { type: "toolCall", id: "c1", name: "echo", arguments: { q: "hi" } };
    const reply = await harnessFor(storage, scriptedStream([{ calls: [call] }, { text: "完成" }])).prompt("回显 hi");
    expect(reply.content).toEqual([{ type: "text", text: "完成" }]);

    const rows = await getPool().query<{ seq: number; type: string; payload: { type: string; message?: { role: string } } }>(
      `SELECT seq, type, payload FROM agent_session_entry WHERE session_id = $1 ORDER BY seq`, [sessionId],
    );
    expect(rows.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.rows.map((r) => r.payload.message?.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(rows.rows.every((r) => r.type === "message" && r.payload.type === "message")).toBe(true);

    const reloaded = await PgSessionStorage.load(sessionId);
    expect(reloaded).not.toBeNull();
    const ctx = await new Session(reloaded!).buildContext();
    expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(await reloaded!.getLeafId()).toBe(await storage.getLeafId());
  });

  it("③ 进程死在工具执行中（assistant toolUse 已落行、无 toolResult）→ 新进程从 DB 装载、修复、续跑", async () => {
    const storage = await newStorage(prodId);
    const sessionId = (await storage.getMetadata()).id;
    const call: ToolCall = { type: "toolCall", id: "c2", name: "echo", arguments: { q: "ping" } };
    // 模拟崩溃：只让第一次模型调用完成（assistant toolUse 落库），工具执行阶段 hang 住时"进程死了"
    let hangResolve: () => void = () => {};
    const hanging: RuntimeTool = {
      ...echo,
      execute: () => new Promise((resolve) => { hangResolve = () => resolve({ content: [{ type: "text", text: "never" }], details: undefined }); }),
    };
    const harness = new CoreAgentHarness({
      env: {} as ExecutionEnv, session: new Session(storage), tools: [hanging], model: MODEL, systemPrompt: "t",
      runtime: { streamSimple: scriptedStream([{ calls: [call] }]), completeSimple: async () => { throw new Error("unused"); } },
    });
    const inflight = harness.prompt("回显 ping");
    // 等 assistant(toolUse) 落库
    await new Promise<void>((resolve) => {
      const tick = async () => {
        const n = await getPool().query(`SELECT count(*)::int AS n FROM agent_session_entry WHERE session_id = $1`, [sessionId]);
        if (n.rows[0].n >= 2) resolve(); else setTimeout(tick, 20);
      };
      void tick();
    });
    // "进程死了"：丢掉 harness/storage 对象，不再等它
    void inflight.catch(() => {});

    // 新进程：从 DB 装载 → 修复 → 续跑
    const reloaded = await PgSessionStorage.load(sessionId);
    const session = new Session(reloaded!);
    const decision = await repairAndClassify(session, new Map([[echo.name, echo]]));
    expect(decision).toEqual({ kind: "continue", repaired: [{ toolCallId: "c2", toolName: "echo", action: "re-executed" }] });
    const resumed = new CoreAgentHarness({
      env: {} as ExecutionEnv, session, tools: [echo], model: MODEL, systemPrompt: "t",
      runtime: { streamSimple: scriptedStream([{ text: "续上了" }]), completeSimple: async () => { throw new Error("unused"); } },
    });
    const reply = await resumed.continueTurn();
    expect(reply.content).toEqual([{ type: "text", text: "续上了" }]);

    const roles = (await getPool().query<{ payload: { message?: { role: string } } }>(
      `SELECT payload FROM agent_session_entry WHERE session_id = $1 ORDER BY seq`, [sessionId],
    )).rows.map((r) => r.payload.message?.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    hangResolve(); // 释放旧进程的悬挂 promise，避免测试进程泄漏
  });

  it("④ 同一 entry_id 重复追加被唯一约束拒绝，内存树不被污染", async () => {
    const storage = await newStorage(null);
    const session = new Session(storage);
    const id = await session.appendMessage({ role: "user", content: [{ type: "text", text: "x" }], timestamp: Date.now() });
    const dup = (await storage.getEntry(id))!;
    await expect(storage.appendEntry(dup)).rejects.toThrow();
    expect((await storage.getEntries()).length).toBe(1);
  });

  it("load 不存在的会话 → null", async () => {
    expect(await PgSessionStorage.load("as_nope")).toBeNull();
  });
});
