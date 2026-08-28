// 自建运行时的 run 服务（#367 S2）：把 vendor harness、PG 会话树、事件分发、
// 审批门、注入链、记账串成一次 run。既可在 next 进程内跑（测试/灰度首期），也是
// agent-runner 独立进程的核心——进程边界只是把这里的函数包一层 loopback HTTP。
//
// 一次 run 的骨架：
//   ensureSession → agent_run(running, owner, heartbeat) → 注入链 → harness
//   → [hooks: context(召回临时插入) / tool_call(审批门) / tool_result(方言幂等)]
//   → 事件经 StreamLine 适配器 → EventPublisher（agent_event + NOTIFY）
//   → 收尾：记账 ai_usage、compaction 检查、episodic 上报、agent_run 终态
//
// 会话 id = 网关时代的 sessionKey 原样（clickin:chat:<userId>[:<productionId>]:<uuid>）
// ——路由的所有权判定、前端持有的 key、localStorage 记忆全部不用改。

import { getPool } from "@/lib/pg";
import { parseSessionIdentity } from "@/lib/mcp/session-identity";
import { buildInjectContext } from "@/lib/agent-memory/inject";
import { appendRunRecord } from "@/lib/agent-memory/store";
import { stripUiContext } from "@/lib/agent-ui-context";
import type { ChatSessionSummary, ChatTranscriptEntry } from "@/lib/agent-gateway/types";
import { TOOL_PAYLOAD_MAX_CHARS } from "@/lib/agent-gateway/types";
import { CoreAgentHarness } from "../../vendor/openclaw/packages/agent-core/src/harness/agent-harness";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { compact, estimateContextTokens, shouldCompact, DEFAULT_COMPACTION_SETTINGS } from "../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import type { ExecutionEnv, PromptTemplate, Skill } from "../../vendor/openclaw/packages/agent-core/src/harness/types";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";
import type { StreamFn } from "../../vendor/openclaw/packages/llm-core/src/types";
import { PgSessionStorage } from "./pg-session-storage";
import { EventPublisher, pruneDeltas } from "./events";
import { createStreamLineAdapter } from "./stream-lines";
import { buildTools, bareName, type RuntimeToolDef } from "./tools";
import { approvalCard } from "./cards";
import { createApproval, awaitApproval, markApprovalExecuted } from "./approvals";
import { buildSystemPrompt, recallBlock } from "./prompt";
import { repairAndClassify } from "./resume";
import { newRunId } from "./ids";
import {
  CHAT_MODEL, COMPACTION_MODEL, deepseekApiKey, llmRuntime,
  RUNNER_OWNER, HEARTBEAT_INTERVAL_MS, ORPHAN_AFTER_MS,
} from "./config";

// 我们的工具不碰文件系统/shell；harness 只把 env 传给 systemPrompt 回调
const NO_ENV = {} as ExecutionEnv;

type Harness = CoreAgentHarness<Skill, PromptTemplate, RuntimeToolDef>;
type ActiveRun = { runId: string; harness: Harness; abort: AbortController };
const active = new Map<string, ActiveRun>(); // sessionId → 进行中的 run（同会话单执行者）

/** 测试注入点：替换模型流（默认真 DeepSeek）。 */
export const runtimeOverrides: { streamFn?: StreamFn; apiKey?: string } = {};

export class SessionBusyError extends Error {
  status = 409;
  constructor() { super("该会话已有进行中的回复"); }
}

// ── 会话 ─────────────────────────────────────────────────────────────────────

async function ensureSession(sessionId: string, userId: string): Promise<PgSessionStorage> {
  const existing = await PgSessionStorage.load(sessionId);
  if (existing) return existing;
  const identity = parseSessionIdentity(sessionId);
  if (!identity || identity.userId !== userId) throw Object.assign(new Error("无权访问该会话"), { status: 403 });
  return PgSessionStorage.create({ id: sessionId, userId, productionId: identity.productionId ?? null });
}

export async function isRunnerSession(sessionId: string): Promise<boolean> {
  const r = await getPool().query(`SELECT 1 FROM agent_session WHERE id = $1`, [sessionId]);
  return (r.rowCount ?? 0) > 0;
}

export function sessionRunState(sessionId: string): "running" | "not-running" {
  return active.has(sessionId) ? "running" : "not-running";
}

// ── run ──────────────────────────────────────────────────────────────────────

export interface StartRunInput {
  sessionId: string;
  userId: string;
  message: string;
  pageKey?: string | null;
}

/** 发起一轮（不等待完成）。同会话已有 run 在跑 → 抛 SessionBusyError（调用方转 steer）。 */
export async function startRun(input: StartRunInput): Promise<{ runId: string }> {
  if (active.has(input.sessionId)) throw new SessionBusyError();
  const storage = await ensureSession(input.sessionId, input.userId);
  const runId = newRunId();
  await getPool().query(
    `INSERT INTO agent_run (id, session_id, status, owner, heartbeat_at, page_key, model)
     VALUES ($1, $2, 'running', $3, now(), $4, $5)`,
    [runId, input.sessionId, RUNNER_OWNER, input.pageKey ?? null, CHAT_MODEL.id],
  );
  void execute({ storage, runId, userId: input.userId, message: input.message });
  return { runId };
}

/** 中途插话：交给进行中 run 的 steer 队列（agent-core 在下一次模型调用前注入）。 */
export async function steerRun(sessionId: string, message: string): Promise<{ runId: string } | null> {
  const run = active.get(sessionId);
  if (!run) return null;
  await run.harness.steer(message);
  return { runId: run.runId };
}

export async function abortRun(sessionId: string): Promise<boolean> {
  const run = active.get(sessionId);
  if (!run) return false;
  run.abort.abort();
  await run.harness.abort();
  return true;
}

interface ExecuteInput {
  storage: PgSessionStorage;
  runId: string;
  userId: string;
  /** undefined = 恢复模式：不追加用户消息，从 transcript 续跑 */
  message?: string;
}

async function execute(input: ExecuteInput): Promise<void> {
  const { storage, runId, userId } = input;
  const meta = await storage.getMetadata();
  const sessionId = meta.id;
  const productionId = meta.productionId;
  const pool = getPool();
  const publisher = new EventPublisher(sessionId, runId);
  const abort = new AbortController();
  const session = new Session(storage);
  const tools = buildTools({ userId, productionId });
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const lastUser: string | null = input.message ?? null;
  let lastAssistant: string | null = null;
  let status: "completed" | "aborted" | "failed" = "completed";
  let error: string | null = null;

  const heartbeat = setInterval(() => {
    void pool.query(`UPDATE agent_run SET heartbeat_at = now() WHERE id = $1`, [runId]).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // 注入链：与插件 before_prompt_build 同一份后端组装（instructions/memory/knowledge
    // 进 system prompt；recall 逐轮临时插入，不落 transcript）
    const inject = await buildInjectContext(userId, sessionId, input.message);
    const recall = recallBlock(inject.recall);
    const dialectDelivered = inject.dialectDelivered;

    const harness = new CoreAgentHarness({
      env: NO_ENV,
      session,
      tools,
      systemPrompt: buildSystemPrompt(inject),
      model: CHAT_MODEL,
      getApiKeyAndHeaders: async () => ({ apiKey: runtimeOverrides.apiKey ?? deepseekApiKey() }),
      runtime: runtimeOverrides.streamFn
        ? { streamSimple: runtimeOverrides.streamFn, completeSimple: llmRuntime().completeSimple }
        : { streamSimple: llmRuntime().streamSimple, completeSimple: llmRuntime().completeSimple },
    });
    active.set(sessionId, { runId, harness, abort });

    // 召回临时插入：送模型的消息列表里，最后一条用户消息前插一条 user 消息。
    // 不进 session（下一轮不再带，与 prependContext 语义一致）。
    if (recall) {
      harness.on("context", ({ messages }) => {
        const idx = findLastUserIndex(messages);
        if (idx < 0) return undefined;
        const injected: AgentMessage = { role: "user", content: [{ type: "text", text: recall }], timestamp: Date.now() };
        return { messages: [...messages.slice(0, idx), injected, ...messages.slice(idx)] };
      });
    }

    // 审批门（工具调用权限门原则①）：非只读工具先卡；deny 的理由随工具结果回模型
    harness.on("tool_call", async (event) => {
      const tool = toolByName.get(event.toolName);
      if (!tool || tool.readOnly) return undefined;
      const gate = await approvalGate({ runId, sessionId, userId, productionId, tool, toolCallId: event.toolCallId, args: event.input, publisher, signal: abort.signal });
      return gate;
    });

    // 方言幂等：本轮已送达方言说明时，dialect_ref 只回指引不重付全文
    if (dialectDelivered) {
      harness.on("tool_result", (event) => {
        if (bareName(event.toolName) !== "production-wiki_dialect_ref") return undefined;
        return { content: [{ type: "text", text: "方言说明已在当前语境中（见 <clickin-knowledge> 块或本轮召回内容），无需重复获取，直接按其文法写作即可。" }] };
      });
    }

    // 事件 → 前端行协议 → agent_event/NOTIFY；顺带记账与 episodic 抽取
    const adapter = createStreamLineAdapter((line) => publisher.publish(line));
    harness.subscribe((event) => {
      adapter(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        usage.input += event.message.usage.input;
        usage.output += event.message.usage.output;
        usage.cacheRead += event.message.usage.cacheRead;
        const t = event.message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
        if (t) lastAssistant = t.slice(0, 2000);
      }
    });

    if (input.message !== undefined) {
      await harness.prompt(input.message);
    } else {
      const decision = await repairAndClassify(session, new Map(tools.map((t) => [t.name, t])), { signal: abort.signal });
      if (decision.kind === "continue") await harness.continueTurn();
      else publisher.publish({ type: "final", text: "" });
    }
    if (abort.signal.aborted) status = "aborted";

    // 自动压缩（agent-core 的 compact() 是手动的；触发由这里驱动，摘要用 pro）
    await maybeCompact(harness, session, abort.signal);
  } catch (err) {
    status = abort.signal.aborted ? "aborted" : "failed";
    error = err instanceof Error ? err.message : String(err);
    publisher.publish({ type: "error", error: error || "Agent run did not complete" });
    console.error(`[agent-runtime] run ${runId} failed:`, err);
  } finally {
    clearInterval(heartbeat);
    await publisher.drain();
    await pool.query(
      `UPDATE agent_run SET status = $2, ended_at = now(), error = $3, input_tokens = $4, output_tokens = $5, cache_read_tokens = $6 WHERE id = $1`,
      [runId, status, error, usage.input, usage.output, usage.cacheRead],
    );
    await recordUsage(userId, productionId, usage).catch(() => {});
    await pruneDeltas(sessionId, runId).catch(() => {});
    // episodic 上报（与插件 agent_end 同款字段）
    try {
      appendRunRecord(userId, {
        ts: new Date().toISOString(), sessionKey: sessionId, runId, productionId,
        success: status === "completed", error, durationMs: null,
        lastUser: lastUser ? stripUiContext(lastUser).slice(0, 2000) : null, lastAssistant,
      });
    } catch { /* 记忆归档失败不影响本轮 */ }
    // 最后才释放会话：run 行终态/记账/事件清理都落完，"空闲"才是真的空闲
    // （waitForIdle / sessionRunState / 下一条消息的 SessionBusy 判定都以此为准）
    active.delete(sessionId);
  }
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

async function recordUsage(userId: string, productionId: string | null, usage: { input: number; output: number; cacheRead: number }): Promise<void> {
  const pool = getPool();
  const rows: Array<[string, number]> = [["chat_input", usage.input], ["chat_output", usage.output], ["chat_cache_read", usage.cacheRead]];
  for (const [kind, tokens] of rows) {
    if (tokens <= 0) continue;
    await pool.query(
      `INSERT INTO ai_usage (user_id, production_id, kind, model, tokens) VALUES ($1, $2, $3, $4, $5)`,
      [userId, productionId, kind, CHAT_MODEL.id, tokens],
    );
  }
}

// ── 审批门 ───────────────────────────────────────────────────────────────────

interface GateInput {
  runId: string; sessionId: string; userId: string; productionId: string | null;
  tool: RuntimeToolDef; toolCallId: string; args: Record<string, unknown>;
  publisher: EventPublisher; signal: AbortSignal;
}

const WIKI_PROPOSE_ACTIONS: Record<string, "create" | "update" | "delete" | "move" | "tag"> = {
  "production-wiki_propose_create": "create",
  "production-wiki_propose_update": "update",
  "production-wiki_propose_delete": "delete",
  "production-wiki_propose_move": "move",
  "production-wiki_propose_tag": "tag",
};

async function approvalGate(g: GateInput): Promise<{ block?: boolean; reason?: string } | undefined> {
  const bare = bareName(g.tool.name);
  let hasPermission: boolean | undefined;
  const preview: Record<string, unknown> = {};

  // wiki propose 五兄弟：先方言校验 + 预持久化（与插件路径同一份 prepare）；
  // 校验拒绝 → 直接 block，说明书随理由回模型，卡片根本不弹
  const wikiAction = WIKI_PROPOSE_ACTIONS[bare];
  if (wikiAction && g.productionId) {
    const { prepareWikiProposal } = await import("@/lib/mcp/wiki-proposal-prepare");
    const a = g.args;
    const prepared = await prepareWikiProposal({
      productionId: g.productionId, toolCallId: g.toolCallId, callerUserId: g.userId, action: wikiAction,
      wikiId: str(a.wikiId), parentId: str(a.parentId), newParentId: str(a.newParentId),
      title: str(a.title), body: str(a.body), tags: Array.isArray(a.tags) ? a.tags.map(String) : undefined, summary: str(a.summary),
    });
    if (!prepared.ok) {
      const problemLines = prepared.problems.map((p) => `- ${p}`).join("\n");
      return { block: true, reason: `提议被方言校验拒绝（未提交给用户确认，也未落库）：\n${problemLines}\n\n请按以下方言说明修正正文后重新调用：\n${prepared.guide}` };
    }
    hasPermission = prepared.hasPermission;
    preview.hasPermission = prepared.hasPermission;
    preview.proposalId = prepared.id;
    if (prepared.restoredBody !== undefined) preview.restoredBody = prepared.restoredBody;
  }

  const card = approvalCard(bare, g.args, { hasPermission });
  const { id, info } = await createApproval({
    runId: g.runId, sessionId: g.sessionId, toolCallId: g.toolCallId, tool: g.tool.name, args: g.args, card, preview,
  });
  await getPool().query(`UPDATE agent_run SET status = 'awaiting_approval' WHERE id = $1`, [g.runId]);
  g.publisher.publish({ type: "approval", approval: info });

  const outcome = await awaitApproval(id, g.signal);
  await getPool().query(`UPDATE agent_run SET status = 'running' WHERE id = $1 AND status = 'awaiting_approval'`, [g.runId]);
  if (outcome.kind === "allowed") {
    g.publisher.publish({ type: "approval-resolved", id, decision: outcome.decision });
    await markApprovalExecuted(id);
    return undefined;
  }
  const decision = outcome.kind === "expired" ? "timeout" : "deny";
  g.publisher.publish({ type: "approval-resolved", id, decision });
  const reason = outcome.kind === "expired"
    ? "确认请求超时未处理，本次调用未执行。"
    : `Denied by user${outcome.reason ? `\n用户拒绝理由：${outcome.reason}` : ""}`;
  return { block: true, reason };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ── 压缩 ─────────────────────────────────────────────────────────────────────

async function maybeCompact(harness: Harness, session: Session, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const ctx = await session.buildContext();
  const { tokens } = estimateContextTokens(ctx.messages);
  if (!shouldCompact(tokens, CHAT_MODEL.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
  const off = harness.on("session_before_compact", async ({ preparation, signal: s }) => {
    const result = await compact(preparation, COMPACTION_MODEL, runtimeOverrides.apiKey ?? deepseekApiKey(), undefined, "用中文写摘要", s, "low", undefined, llmRuntime());
    if (!result.ok) throw result.error;
    return { compaction: result.value };
  });
  try {
    await harness.compact();
  } catch (err) {
    console.error("[agent-runtime] compaction failed (continuing):", err);
  } finally {
    off();
  }
}

// ── 历史与列表（前端契约同网关时代）────────────────────────────────────────────

export async function getHistory(sessionId: string): Promise<ChatTranscriptEntry[]> {
  const storage = await PgSessionStorage.load(sessionId);
  if (!storage) return [];
  const ctx = await new Session(storage).buildContext();
  const entries: ChatTranscriptEntry[] = [];
  for (const m of ctx.messages) {
    if (m.role === "user") {
      const content = stripUiContext(textOf(m.content));
      if (content) entries.push({ role: "user", content });
    } else if (m.role === "toolResult") {
      const result = textOf(m.content).slice(0, TOOL_PAYLOAD_MAX_CHARS);
      entries.push({ role: "tool", name: m.toolName, id: m.toolCallId || undefined, ...(result ? { result } : {}) });
    } else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) entries.push({ role: "assistant", content: t });
    }
  }
  return entries;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("");
}

export async function listSessions(userId: string): Promise<ChatSessionSummary[]> {
  const r = await getPool().query<{ id: string; title: string | null; updated_at: Date; first_user: string | null; last_text: string | null }>(
    `SELECT s.id, s.title, s.updated_at,
       (SELECT e.payload->'message'->'content'->0->>'text' FROM agent_session_entry e
         WHERE e.session_id = s.id AND e.type = 'message' AND e.payload->'message'->>'role' = 'user'
         ORDER BY e.seq LIMIT 1) AS first_user,
       (SELECT e.payload->'message'->'content'->0->>'text' FROM agent_session_entry e
         WHERE e.session_id = s.id AND e.type = 'message' AND e.payload->'message'->>'role' IN ('user','assistant')
         ORDER BY e.seq DESC LIMIT 1) AS last_text
     FROM agent_session s WHERE s.user_id = $1 AND s.archived_at IS NULL
     ORDER BY s.updated_at DESC LIMIT 100`,
    [userId],
  );
  return r.rows.map((row) => ({
    key: row.id,
    title: row.title || stripUiContext(row.first_user ?? "").trim().slice(0, 60) || "新对话",
    lastMessagePreview: row.last_text ? stripUiContext(row.last_text).slice(0, 120) : undefined,
    updatedAt: row.updated_at.getTime(),
    status: active.has(row.id) ? "running" : "done",
  }));
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await getPool().query(`UPDATE agent_session SET title = $2, updated_at = now() WHERE id = $1`, [sessionId, title]);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await abortRun(sessionId);
  await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [sessionId]);
}

// ── 重启恢复（§4.4 ①）────────────────────────────────────────────────────────

/** 启动/巡检：接管心跳过期的 run，按中断点修复后续跑。返回接管数。 */
export async function resumeOrphans(): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: string; session_id: string; user_id: string }>(
    `UPDATE agent_run r SET owner = $1, heartbeat_at = now(), status = 'running'
     FROM agent_session s
     WHERE r.session_id = s.id
       AND r.status IN ('running', 'awaiting_approval', 'awaiting_answer')
       AND (r.heartbeat_at IS NULL OR r.heartbeat_at < now() - ($2::int * interval '1 millisecond'))
       AND (r.owner IS NULL OR r.owner <> $1)
     RETURNING r.id, r.session_id, s.user_id`,
    [RUNNER_OWNER, ORPHAN_AFTER_MS],
  );
  for (const row of r.rows) {
    if (active.has(row.session_id)) continue;
    const storage = await PgSessionStorage.load(row.session_id);
    if (!storage) continue;
    void execute({ storage, runId: row.id, userId: row.user_id });
  }
  return r.rows.length;
}

/** 排水（§4.4 ②）：不再接新 run，等进行中的到自然停点；等待态的 run 立即放手。 */
export async function drain(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (active.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 测试用：等待某会话的 run 结束。 */
export async function waitForIdle(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (active.has(sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

export const __internal = { active, execute };
