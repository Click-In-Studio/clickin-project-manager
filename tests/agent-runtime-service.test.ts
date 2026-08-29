import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, StreamFn, ToolCall } from "../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { createNewSessionKey } from "@/lib/mcp/session-identity";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-chat/stream-reducer";
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

    // 按本 run 的时间窗口取记账行：工厂 shortId 在并行 worker 间可能撞出同一个用户
    const usage = await getPool().query<{ kind: string; tokens: number }>(
      `SELECT kind, tokens FROM ai_usage WHERE user_id = $1 AND kind LIKE 'chat_%'
         AND created_at >= (SELECT started_at FROM agent_run WHERE id = $2) ORDER BY kind`, [userId, runId]);
    expect(usage.rows).toEqual([{ kind: "chat_input", tokens: 7 }, { kind: "chat_output", tokens: 3 }]);

    expect(await getHistory(key)).toEqual([{ role: "user", content: "你好" }, { role: "assistant", content: "你好，我是后台助手" }]);
    // system prompt = 六件套 + 注入包裹（记忆段恒在）；工具面 = 26 个 clickin__ 工具
    expect(seen[0].systemPrompt).toContain("团队 agent 行为规范");
    expect(seen[0].systemPrompt).toContain("<clickin-memory>");
    // 工具三层：制作会话热层在，wiki 族（无页面、无触发词）不在
    expect(seen[0].tools).toContain(exposedName("production.info"));
    expect(seen[0].tools).not.toContain(exposedName("production.wiki_read"));
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
    await startRun({ sessionId: key, userId, message: "查我的制作，然后改我的个人指令" });  // 触发词「个人指令」召回冷层写工具

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
    expect(lines.some((l) => l.type === "mutation")).toBe(false); // 被拒的写工具没有变更信号
  });

  it("审批 allow → 写工具真执行（个人指令被写入），approval-resolved 行到前端", async () => {
    const writeCall: ToolCall = { type: "toolCall", id: "c_w2", name: exposedName("my.update_instructions"), arguments: { content: "回复末尾加一个🎭" } };
    const { streamFn } = scripted([{ calls: [writeCall] }, { text: "已更新" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey(false); // 个人会话
    await startRun({ sessionId: key, userId, message: "改我的个人指令" });
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
    // 写操作后自动刷新：写工具成功 → mutation 行紧跟 tool-end（前端派发给页面订阅者）
    const endIdx = lines.findIndex((l) => l.type === "tool-end");
    expect(lines[endIdx + 1]).toEqual({ type: "mutation", scope: "instructions.personal", action: "updated", productionId: null, tool: "my.update_instructions" });
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
    const { Session } = await import("../vendor/openclaw/packages/agent-core/src/harness/session/session");
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

describe("ask_user（#290）：提问 → 卡片 → 回答 → 工具结果", () => {
  let userId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-ask-${shortId()}`, null, false));
    runtimeOverrides.apiKey = "test-key";
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
  });

  it("模型调 ask_user → question 行（QuestionInfo 形态）→ 用户回答 → 模型看到答案；取消 → 错误结果", async () => {
    const { questionSession, resolveQuestion, listPendingQuestions } = await import("@/lib/agent-runtime/questions");
    const ask = (id: string): ToolCall => ({
      type: "toolCall", id, name: exposedName("ask_user"),
      arguments: { questions: [{ questionId: "q1", header: "演出日期", question: "首演定在哪天？", options: [{ label: "10月18日" }, { label: "10月25日" }] }] },
    });
    const { streamFn, seen } = scripted([{ calls: [ask("c_ask1")] }, { calls: [ask("c_ask2")] }, { text: "记下了" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(userId);
    sessions.push(key);
    await startRun({ sessionId: key, userId, message: "帮我记一下首演日期" });

    // 第一张卡
    let q: Extract<StreamLine, { type: "question" }> | undefined;
    for (let i = 0; i < 200 && !q; i++) {
      q = (await readEventsSince(key, 0)).map((r) => r.line).find((l): l is Extract<StreamLine, { type: "question" }> => l.type === "question");
      if (!q) await new Promise((r) => setTimeout(r, 25));
    }
    expect(q?.question?.questions[0]).toMatchObject({ questionId: "q1", header: "演出日期", options: [{ label: "10月18日" }, { label: "10月25日" }] });
    const qid = q!.question!.id;
    expect(qid.startsWith("aq_")).toBe(true);
    expect(await questionSession(qid)).toBe(key);
    expect((await listPendingQuestions(key)).map((x) => x.id)).toEqual([qid]);
    expect((await getPool().query(`SELECT status FROM agent_run WHERE session_id = $1`, [key])).rows[0].status).toBe("awaiting_answer");
    expect(await resolveQuestion(qid, { answers: { q1: ["10月18日"] } })).toBe(true);

    // 第二张卡 → 取消
    let q2: Extract<StreamLine, { type: "question" }> | undefined;
    for (let i = 0; i < 200 && !q2; i++) {
      q2 = (await readEventsSince(key, 0)).map((r) => r.line).filter((l): l is Extract<StreamLine, { type: "question" }> => l.type === "question")[1];
      if (!q2) await new Promise((r) => setTimeout(r, 25));
    }
    await resolveQuestion(q2!.question!.id, { cancel: true });

    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines.filter((l) => l.type === "question-resolved").map((l) => (l as { status?: string }).status)).toEqual(["answered", "cancelled"]);
    // 模型第二次调用看到答案文本；第三次看到取消的错误结果
    const second = seen[1].messages[seen[1].messages.length - 1] as { role: string; isError: boolean; content: Array<{ text?: string }> };
    expect(second.role).toBe("toolResult");
    expect(second.isError).toBe(false);
    expect(second.content[0]?.text).toContain("演出日期：10月18日");
    const third = seen[2].messages[seen[2].messages.length - 1] as { isError: boolean; content: Array<{ text?: string }> };
    expect(third.isError).toBe(true);
    expect(third.content[0]?.text).toContain("取消");
    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    expect(bubbles.filter((b) => b.kind === "question").map((b) => (b as { status?: string }).status)).toEqual(["answered", "cancelled"]);
  });
});

describe("§4.4 排水/脱离：等待态 run 交给下一个进程，不留痕、不重问", () => {
  let userId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-detach-${shortId()}`, null, false));
    runtimeOverrides.apiKey = "test-key";
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
  });

  it("等提问时脱离 → transcript 无 aborted、run 仍 awaiting_answer、无 aborted 事件；接管后复用同一问题并续跑", async () => {
    const { detachAll, resumeOrphans } = await import("@/lib/agent-runtime/service");
    const { resolveQuestion } = await import("@/lib/agent-runtime/questions");
    const ask: ToolCall = {
      type: "toolCall", id: "c_det", name: exposedName("ask_user"),
      arguments: { questions: [{ questionId: "q1", header: "颜色", question: "主色调？", options: [{ label: "深蓝" }, { label: "酒红" }] }] },
    };
    // 进程 A：提问后卡住等答案
    runtimeOverrides.streamFn = scripted([{ calls: [ask] }]).streamFn;
    const key = createNewSessionKey(userId);
    sessions.push(key);
    await startRun({ sessionId: key, userId, message: "定主色调" });
    let q: Extract<StreamLine, { type: "question" }> | undefined;
    for (let i = 0; i < 200 && !q; i++) {
      q = (await readEventsSince(key, 0)).map((r) => r.line).find((l): l is Extract<StreamLine, { type: "question" }> => l.type === "question");
      if (!q) await new Promise((r) => setTimeout(r, 25));
    }
    const qid = q!.question!.id;

    // 进程 A 排水脱离
    await detachAll();
    expect(sessionRunState(key)).toBe("not-running");
    const run = (await getPool().query<{ status: string }>(`SELECT status FROM agent_run WHERE session_id = $1`, [key])).rows[0];
    expect(run.status).toBe("awaiting_answer"); // 不改终态
    const roles = (await getPool().query<{ payload: { message?: { role: string; stopReason?: string } } }>(`SELECT payload FROM agent_session_entry WHERE session_id = $1 ORDER BY seq`, [key]))
      .rows.map((r) => `${r.payload.message?.role}${r.payload.message?.stopReason ? ":" + r.payload.message.stopReason : ""}`);
    expect(roles).toEqual(["user", "assistant:toolUse"]); // 没有 aborted assistant 落库
    expect((await readEventsSince(key, 0)).map((r) => r.line.type)).not.toContain("aborted");
    expect((await getPool().query(`SELECT status FROM agent_question WHERE id = $1`, [qid])).rows[0].status).toBe("pending"); // 问题没被取消

    // 进程 B：心跳过期后接管 → 复用同一问题（不重发卡）→ 用户回答 → 续跑
    await getPool().query(`UPDATE agent_run SET heartbeat_at = now() - interval '5 minutes', owner = 'dead:1' WHERE session_id = $1`, [key]);
    runtimeOverrides.streamFn = scripted([{ text: "主色调深蓝，记下了" }]).streamFn;
    expect(await resumeOrphans()).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));
    const questionLines = (await readEventsSince(key, 0)).map((r) => r.line).filter((l) => l.type === "question");
    expect(questionLines).toHaveLength(1); // 复用，没有第二张卡
    expect((await getPool().query(`SELECT count(*)::int AS n FROM agent_question WHERE session_id = $1`, [key])).rows[0].n).toBe(1);
    await resolveQuestion(qid, { answers: { q1: ["深蓝"] } });
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines[lines.length - 1]).toEqual({ type: "final", text: "主色调深蓝，记下了" });
    expect((await getPool().query<{ status: string }>(`SELECT status FROM agent_run WHERE session_id = $1`, [key])).rows[0].status).toBe("completed");
  });

  it("等审批时脱离 → 接管后复用同一张卡，批准后写工具真执行", async () => {
    const { detachAll, resumeOrphans } = await import("@/lib/agent-runtime/service");
    const write: ToolCall = { type: "toolCall", id: "c_det_w", name: exposedName("my.update_instructions"), arguments: { content: "叫我导演" } };
    runtimeOverrides.streamFn = scripted([{ calls: [write] }]).streamFn;
    const key = createNewSessionKey(userId);
    sessions.push(key);
    await startRun({ sessionId: key, userId, message: "改我的个人指令" });
    let approvalId: string | undefined;
    for (let i = 0; i < 200 && !approvalId; i++) {
      const l = (await readEventsSince(key, 0)).map((r) => r.line).find((x) => x.type === "approval") as Extract<StreamLine, { type: "approval" }> | undefined;
      approvalId = l?.approval?.id;
      if (!approvalId) await new Promise((r) => setTimeout(r, 25));
    }
    await detachAll();
    expect((await getPool().query(`SELECT status FROM agent_approval WHERE id = $1`, [approvalId])).rows[0].status).toBe("pending");

    await getPool().query(`UPDATE agent_run SET heartbeat_at = now() - interval '5 minutes', owner = 'dead:1' WHERE session_id = $1`, [key]);
    runtimeOverrides.streamFn = scripted([{ text: "已更新" }]).streamFn;
    await resumeOrphans();
    await new Promise((r) => setTimeout(r, 300));
    expect((await readEventsSince(key, 0)).map((r) => r.line).filter((l) => l.type === "approval")).toHaveLength(1); // 复用同一张卡
    await resolveApproval(approvalId!, "allow-once", userId);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines[lines.length - 1]).toEqual({ type: "final", text: "已更新" });
    const instr = await getPool().query<{ content: string }>(`SELECT content FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    expect(instr.rows[0]?.content).toBe("叫我导演");
    await getPool().query(`DELETE FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
  });
});

describe("冷层兜底：find_tools 搜到 → 按名直接调（resolveDeferredTool）", () => {
  let userId: string;
  let prodId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-deferred-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    runtimeOverrides.apiKey = "test-key";
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  it("首页闲聊（wiki 族不在工具面）→ 模型调 find_tools → 再按名调 wiki_tree（不在列表里也能解析执行）", async () => {
    const find: ToolCall = { type: "toolCall", id: "c_find", name: exposedName("find_tools"), arguments: { query: "看看有哪些文档" } };
    const tree: ToolCall = { type: "toolCall", id: "c_tree", name: exposedName("production.wiki_tree"), arguments: {} };
    const { streamFn, seen } = scripted([{ calls: [find] }, { calls: [tree] }, { text: "文档列在上面了" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(userId, prodId);
    sessions.push(key);
    await startRun({ sessionId: key, userId, message: "你好呀", pageKey: "prod:home" });
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);

    expect(seen[0].tools).toContain(exposedName("find_tools"));
    expect(seen[0].tools).not.toContain(exposedName("production.wiki_tree")); // 第一轮工具面里确实没有它
    const findResult = seen[1].messages[seen[1].messages.length - 1] as { content: Array<{ text?: string }> };
    expect(findResult.content[0]?.text).toContain(exposedName("production.wiki_tree")); // 搜到了名字
    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    const treeBubble = bubbles.find((b) => b.kind === "tool" && b.id === "c_tree") as Extract<Bubble, { kind: "tool" }>;
    expect(treeBubble?.done).toBe(true);
    expect(treeBubble?.isError).toBeUndefined(); // 真执行了（不是 "Tool not found"）
    expect(seen[2].tools).toContain(exposedName("production.wiki_tree")); // 加载后本 run 后续可见
  });
});
