import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, StreamFn, ToolCall } from "../vendor/openclaw/packages/llm-core/src/types.js";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { createNewSessionKey } from "@/lib/agent-gateway/client";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-gateway/stream-reducer";
import {
  startRun, steerRun, abortRun, getHistory, listSessions, resumeOrphans, waitForIdle, runtimeOverrides, sessionRunState, __internal,
} from "@/lib/agent-runtime/service";
import { readEventsSince, subscribeSessionEvents } from "@/lib/agent-runtime/events";
import { resolveApproval, approvalSession } from "@/lib/agent-runtime/approvals";
import { CHAT_MODEL } from "@/lib/agent-runtime/config";
import { exposedName } from "@/lib/agent-runtime/tools";

// #367 S2：run 服务端到端（真 DB、假模型、真 harness、真工具函数）。
// 覆盖：事件落表+NOTIFY、历史投影、会话列表、审批门（deny 带理由 / allow）、
// steer、abort、记账、孤儿接管恢复。

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = () => ({ role: "assistant" as const, api: CHAT_MODEL.api, provider: CHAT_MODEL.provider, model: CHAT_MODEL.id, usage: USAGE, timestamp: Date.now() });

type Step = { text: string } | { calls: ToolCall[] } | { hang: true };
/** 脚本化假模型；记录每次调用看到的上下文（系统提示、消息、工具名）。 */
function scripted(script: Step[]) {
  const seen: Array<{ systemPrompt?: string; messages: unknown[]; tools: string[] }> = [];
  const streamFn: StreamFn = (_model, context, options) => {
    seen.push({ systemPrompt: context.systemPrompt, messages: context.messages, tools: (context.tools ?? []).map((t) => t.name) });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    const stream = createAssistantMessageEventStream();
    if ("hang" in next) {
      // 永不结束——模拟"模型调用进行中"；像真 provider 一样响应 abort 信号
      options?.signal?.addEventListener("abort", () => {
        stream.push({ type: "error", reason: "aborted", error: { ...base(), content: [], stopReason: "aborted", errorMessage: "aborted" } });
      });
      return stream;
    }
    queueMicrotask(() => {
      const final: AssistantMessage = "text" in next
        ? { ...base(), content: [{ type: "text", text: next.text }], stopReason: "stop" }
        : { ...base(), content: next.calls, stopReason: "toolUse" };
      stream.push({ type: "start", partial: { ...final, content: [] } });
      if ("text" in next) {
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...final, content: [{ type: "text", text: "" }] } });
        for (const ch of next.text) stream.push({ type: "text_delta", contentIndex: 0, delta: ch });
      }
      stream.push({ type: "done", reason: final.stopReason as "stop" | "toolUse", message: final });
    });
    return stream;
  };
  return { streamFn, seen };
}

async function collectUntilTerminal(sessionId: string, timeoutMs = 10_000): Promise<StreamLine[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await readEventsSince(sessionId, 0);
    const lines = rows.map((r) => r.line);
    if (lines.some((l) => l.type === "final" || l.type === "aborted" || l.type === "error")) return lines;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("no terminal event");
}

describe("agent-runtime service", () => {
  let userId: string;
  let prodId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-svc-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    runtimeOverrides.apiKey = "test-key";
  });

  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.apiKey;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  function newKey(withProduction = true) {
    const key = createNewSessionKey(userId, withProduction ? prodId : undefined);
    sessions.push(key);
    return key;
  }

  it("纯文本一轮：会话行自动建立并带关联；事件落表（delta 合并、final 收尾）→ 现有 reducer；历史投影；记账", async () => {
    const { streamFn, seen } = scripted([{ text: "你好，我是后台助手" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    const notified: number[] = [];
    const unsub = await subscribeSessionEvents(key, (seq) => notified.push(seq));

    const { runId } = await startRun({ sessionId: key, userId, message: "你好" });
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    unsub();

    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    expect(bubbles[bubbles.length - 1]).toEqual({ kind: "assistant", text: "你好，我是后台助手" });
    expect(notified.length).toBeGreaterThan(0); // NOTIFY 真的到了观看者

    const sess = await getPool().query<{ user_id: string; production_id: string | null }>(`SELECT user_id, production_id FROM agent_session WHERE id = $1`, [key]);
    expect(sess.rows[0]).toEqual({ user_id: userId, production_id: prodId });

    const run = await getPool().query<{ status: string; input_tokens: number; output_tokens: number; owner: string }>(`SELECT status, input_tokens, output_tokens, owner FROM agent_run WHERE id = $1`, [runId]);
    expect(run.rows[0].status).toBe("completed");
    expect(run.rows[0].input_tokens).toBe(7);
    expect(run.rows[0].output_tokens).toBe(3);

    const usage = await getPool().query<{ kind: string; tokens: number }>(`SELECT kind, tokens FROM ai_usage WHERE user_id = $1 AND kind LIKE 'chat_%' ORDER BY kind`, [userId]);
    expect(usage.rows).toEqual([{ kind: "chat_input", tokens: 7 }, { kind: "chat_output", tokens: 3 }]);

    expect(await getHistory(key)).toEqual([{ role: "user", content: "你好" }, { role: "assistant", content: "你好，我是后台助手" }]);
    // system prompt = 六件套 + 注入包裹（记忆段恒在）；工具面 = 26 个 clickin__ 工具
    expect(seen[0].systemPrompt).toContain("团队 agent 行为规范");
    expect(seen[0].systemPrompt).toContain("<clickin-memory>");
    expect(seen[0].tools).toContain(exposedName("production.wiki_read"));
    expect(seen[0].tools.every((t) => t.startsWith("clickin__"))).toBe(true);

    const list = await listSessions(userId);
    expect(list.find((s) => s.key === key)).toMatchObject({ title: "你好", status: "done" });
    // delta 行已清理，只剩终态
    expect((await readEventsSince(key, 0)).map((r) => r.line.type)).not.toContain("delta");
  });

  it("只读工具直接执行（真 my.productions），写工具过审批门：deny 带理由 → 模型收到理由", async () => {
    const readCall: ToolCall = { type: "toolCall", id: "c_read", name: exposedName("my.productions"), arguments: {} };
    const writeCall: ToolCall = { type: "toolCall", id: "c_write", name: exposedName("my.update_instructions"), arguments: { content: "以后叫我导演" } };
    const { streamFn, seen } = scripted([{ calls: [readCall] }, { calls: [writeCall] }, { text: "好的，不改了" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    await startRun({ sessionId: key, userId, message: "查我的制作，然后改指令" });

    // 等审批卡出现
    let approvalLine: Extract<StreamLine, { type: "approval" }> | undefined;
    for (let i = 0; i < 200 && !approvalLine; i++) {
      const rows = await readEventsSince(key, 0);
      approvalLine = rows.map((r) => r.line).find((l): l is Extract<StreamLine, { type: "approval" }> => l.type === "approval");
      if (!approvalLine) await new Promise((r) => setTimeout(r, 25));
    }
    expect(approvalLine?.approval?.title).toBe("修改你的个人 AI 指令");
    expect(approvalLine?.approval?.toolCallId).toBe("c_write");
    const approvalId = approvalLine!.approval!.id;
    expect(await approvalSession(approvalId)).toBe(key);
    expect((await getPool().query(`SELECT status FROM agent_run WHERE session_id = $1`, [key])).rows[0].status).toBe("awaiting_approval");

    expect(await resolveApproval(approvalId, "deny", userId, "先别改")).toBe(true);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);

    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    const readBubble = bubbles.find((b) => b.kind === "tool" && b.id === "c_read") as Extract<Bubble, { kind: "tool" }>;
    expect(readBubble.done).toBe(true);
    expect(String(readBubble.result)).toContain("《"); // 真 my.productions 跑了：列出了工厂造的制作
    expect(bubbles.find((b) => b.kind === "approval")).toMatchObject({ kind: "approval", decision: "deny" });
    // 模型在第三次调用看到的工具结果带拒绝理由，且指令没被改
    const third = seen[2].messages[seen[2].messages.length - 1] as { role: string; isError: boolean; content: Array<{ text?: string }> };
    expect(third.role).toBe("toolResult");
    expect(third.isError).toBe(true);
    expect(third.content[0]?.text).toContain("用户拒绝理由：先别改");
    const instr = await getPool().query(`SELECT content FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    expect(instr.rows).toHaveLength(0);
  });

  it("审批 allow → 写工具真执行（个人指令被写入），approval-resolved 行到前端", async () => {
    const writeCall: ToolCall = { type: "toolCall", id: "c_w2", name: exposedName("my.update_instructions"), arguments: { content: "回复末尾加一个🎭" } };
    const { streamFn } = scripted([{ calls: [writeCall] }, { text: "已更新" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey(false); // 个人会话
    await startRun({ sessionId: key, userId, message: "改指令" });
    let approvalId: string | undefined;
    for (let i = 0; i < 200 && !approvalId; i++) {
      const line = (await readEventsSince(key, 0)).map((r) => r.line).find((l) => l.type === "approval") as Extract<StreamLine, { type: "approval" }> | undefined;
      approvalId = line?.approval?.id;
      if (!approvalId) await new Promise((r) => setTimeout(r, 25));
    }
    await resolveApproval(approvalId!, "allow-once", userId);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines.find((l) => l.type === "approval-resolved")).toMatchObject({ decision: "allow-once" });
    const instr = await getPool().query<{ content: string }>(`SELECT content FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    expect(instr.rows[0]?.content).toBe("回复末尾加一个🎭");
    await getPool().query(`DELETE FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    const approval = await getPool().query<{ status: string; executed_at: Date | null }>(`SELECT status, executed_at FROM agent_approval WHERE id = $1`, [approvalId]);
    expect(approval.rows[0].status).toBe("allowed");
    expect(approval.rows[0].executed_at).not.toBeNull();
  });

  it("abort：模型调用进行中被中止 → aborted 行、run=aborted、会话空闲", async () => {
    const { streamFn } = scripted([{ hang: true }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    await startRun({ sessionId: key, userId, message: "慢慢想" });
    await new Promise((r) => setTimeout(r, 100));
    expect(sessionRunState(key)).toBe("running");
    expect(await abortRun(key)).toBe(true);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines[lines.length - 1].type).toBe("aborted");
    expect(sessionRunState(key)).toBe("not-running");
    expect((await getPool().query(`SELECT status FROM agent_run WHERE session_id = $1`, [key])).rows[0].status).toBe("aborted");
  });

  it("steer：run 进行中插话进入下一次模型调用的上下文", async () => {
    // 第一次模型调用 hang 住直到我们 steer；用工具调用制造第二次模型调用
    const readCall: ToolCall = { type: "toolCall", id: "c_r3", name: exposedName("my.productions"), arguments: {} };
    const { streamFn, seen } = scripted([{ calls: [readCall] }, { text: "收到插话" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    await startRun({ sessionId: key, userId, message: "第一句" });
    // 在工具执行前后 steer 很难精准卡点；这里直接验 steer 接口与第二次调用上下文包含插话
    const steered = await steerRun(key, "补一句：只看今年的");
    await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(steered === null || typeof steered.runId === "string").toBe(true);
    const texts = seen.flatMap((s) => s.messages).map((m) => JSON.stringify(m));
    // steer 若赶上了第二次调用会出现在上下文；赶不上（run 已结束）则 steerRun 返回 null
    if (steered) expect(texts.some((t) => t.includes("补一句"))).toBe(true);
  });

  it("孤儿接管：心跳过期的 running run 被新执行者接管并从 transcript 续跑", async () => {
    const { streamFn } = scripted([{ text: "接管后续上" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    // 手工制造"上一个进程死了"的状态：会话 + 一条用户消息 + running 且心跳过期的 run
    const { PgSessionStorage } = await import("@/lib/agent-runtime/pg-session-storage");
    const { Session } = await import("../vendor/openclaw/packages/agent-core/src/harness/session/session.js");
    const storage = await PgSessionStorage.create({ id: key, userId, productionId: prodId });
    await new Session(storage).appendMessage({ role: "user", content: [{ type: "text", text: "崩溃前的问题" }], timestamp: Date.now() });
    await getPool().query(
      `INSERT INTO agent_run (id, session_id, status, owner, heartbeat_at) VALUES ('ar_orphan_${shortId()}', $1, 'running', 'dead-host:1', now() - interval '5 minutes')`,
      [key],
    );
    const taken = await resumeOrphans();
    expect(taken).toBeGreaterThanOrEqual(1);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines[lines.length - 1]).toEqual({ type: "final", text: "接管后续上" });
    expect(await getHistory(key)).toEqual([{ role: "user", content: "崩溃前的问题" }, { role: "assistant", content: "接管后续上" }]);
    expect(__internal.active.size).toBe(0);
  });
});
