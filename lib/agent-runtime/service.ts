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
import { parseSessionIdentity } from "@/lib/agent-tools/session-identity";
import { buildInjectContext } from "@/lib/agent-memory/inject";
import { appendRunRecord } from "@/lib/agent-memory/store";
import { stripUiContext } from "@/lib/agent-ui-context";
import type { ChatSessionSummary, ChatTranscriptEntry } from "@/lib/agent-chat/types";
import { TOOL_PAYLOAD_MAX_CHARS } from "@/lib/agent-chat/types";
import type { StreamLine } from "@/lib/agent-chat/stream-reducer";
import { CoreAgentHarness } from "../../vendor/openclaw/packages/agent-core/src/harness/agent-harness";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { compact, estimateContextTokens, shouldCompact, DEFAULT_COMPACTION_SETTINGS } from "../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import type { ExecutionEnv, PromptTemplate, Skill } from "../../vendor/openclaw/packages/agent-core/src/harness/types";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";
import type { ToolCall } from "../../vendor/openclaw/packages/llm-core/src/types";
import type { StreamFn } from "../../vendor/openclaw/packages/llm-core/src/types";
import { PgSessionStorage } from "./pg-session-storage";
import { EventPublisher, pruneDeltas } from "./events";
import { createStreamLineAdapter } from "./stream-lines";
import { buildTools, bareName, exposedName, type RuntimeToolDef } from "./tools";
import { tieredToolNames } from "./tool-tiers";
import { recallFamilies } from "./tool-index";
import { recentlyUsedToolNames } from "./used-tools";
import { approvalCard } from "./cards";
import { createApproval, awaitApproval, markApprovalExecuted, approvalAllowsReexecute } from "./approvals";
import { buildSystemPrompt, recallBlock } from "./prompt";
import { repairAndClassify } from "./resume";
import { newRunId } from "./ids";
import {
  CHAT_MODEL, COMPACTION_MODEL, deepseekApiKey, llmRuntime,
  RUNNER_OWNER, HEARTBEAT_INTERVAL_MS, ORPHAN_AFTER_MS,
} from "./config";
import { creditsFromUsd, RUN_CREDIT_HARD_CAP } from "@/lib/plan";
import { assertAiQuota, chargeExtraCredits, getQuotaStatus, paidFromOf, quotaOwnerOf, type PaidFrom } from "@/lib/ai-quota";
import { usdOfUsage } from "./billing";

// 我们的工具不碰文件系统/shell；harness 只把 env 传给 systemPrompt 回调
const NO_ENV = {} as ExecutionEnv;

type Harness = CoreAgentHarness<Skill, PromptTemplate, RuntimeToolDef>;
type ActiveRun = { runId: string; harness: Harness; abort: AbortController; detach: () => void };
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
  // 额度门（#383）：只挡**新发起**的一轮。孤儿接管/审批后续跑不再判——那是
  // 已经开始的一次任务，判定的位置是这里，不是循环里。超限抛 429，文案由
  // assertAiQuota 按「找谁补」分三种人写。
  const { paidFrom } = await assertAiQuota({
    userId: input.userId,
    productionId: (await storage.getMetadata()).productionId,
  });
  const runId = newRunId();
  await getPool().query(
    `INSERT INTO agent_run (id, session_id, status, owner, heartbeat_at, page_key, model)
     VALUES ($1, $2, 'running', $3, now(), $4, $5)`,
    [runId, input.sessionId, RUNNER_OWNER, input.pageKey ?? null, CHAT_MODEL.id],
  );
  void execute({ storage, runId, userId: input.userId, message: input.message, pageKey: input.pageKey ?? null, paidFrom });
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
  /** 发起本轮时的页面（温层工具面依据）；恢复模式从 agent_run.page_key 读回 */
  pageKey?: string | null;
  /** 本轮由谁买单（run 开始时定死，run 内不切换）；恢复模式无此判定，按 quota 记 */
  paidFrom?: PaidFrom;
}

async function execute(input: ExecuteInput): Promise<void> {
  const { storage, runId, userId } = input;
  const meta = await storage.getMetadata();
  const sessionId = meta.id;
  const productionId = meta.productionId;
  const pool = getPool();
  const rawPublisher = new EventPublisher(sessionId, runId);
  const abort = new AbortController();
  // 脱离（§4.4 ②）：本地停手但不留痕——不写 transcript、不发 aborted 行、不改 run 终态，
  // 下一个进程按孤儿接管续跑
  let detached = false;
  const publisher = {
    publish: (line: StreamLine) => { if (!detached) rawPublisher.publish(line); },
    drain: () => rawPublisher.drain(),
  };
  const session = new Session(storage);
  const runHandle = {
    runId, sessionId, signal: abort.signal,
    publish: (line: StreamLine) => publisher.publish(line),
    setStatus: async (s: "running" | "awaiting_answer") => {
      await pool.query(`UPDATE agent_run SET status = $2 WHERE id = $1 AND status IN ('running', 'awaiting_answer')`, [runId, s]);
    },
    isDetached: () => detached,
  };
  const tools = buildTools({ userId, productionId, run: runHandle });
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  // usd 与 token 并行累计：token 是账本原貌，usd 是限流口径（见 billing.ts）。
  // compaction 单列：它用的是 v4-pro（3 倍单价）、不走 message_end，混进 chat_*
  // 会让「这轮对话花了多少 token」失真。
  const usage = { input: 0, output: 0, cacheRead: 0, usd: 0, compactionUsd: 0, compactionTokens: 0 };
  const lastUser: string | null = input.message ?? null;
  let lastAssistant: string | null = null;
  let status: "completed" | "aborted" | "failed" = "completed";
  let error: string | null = null;

  const toolArgs = new Map<string, Record<string, unknown>>(); // toolCallId → args（mutation 行用）
  const heartbeat = setInterval(() => {
    void pool.query(`UPDATE agent_run SET heartbeat_at = now() WHERE id = $1`, [runId]).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // 注入链：与插件 before_prompt_build 同一份后端组装（instructions/memory/knowledge
    // 进 system prompt；recall 逐轮临时插入，不落 transcript）
    // 工具召回（tool-index：词法+向量）先算——提示块与工具面共用同一份命中。
    // 恢复模式没有本轮 prompt，用 transcript 最后一条用户消息做召回输入。
    const transcript = await session.buildContext().then((c) => c.messages);
    const recallPrompt = input.message ?? lastUserText(transcript);
    // 留存最近几轮用过的工具（有淘汰窗口，见 used-tools.ts）；不认识的名字丢掉
    const used = recentlyUsedToolNames(transcript)
      .map((n) => toolByName.get(n)?.mcpName)
      .filter((n): n is string => !!n);
    const families = recallPrompt
      ? await recallFamilies(stripUiContext(recallPrompt), { hasProduction: !!productionId, userId })
      : [];
    const recalled = families.flatMap((f) => f.tools.map((t) => t.name));

    const inject = await buildInjectContext(userId, sessionId, input.message, { toolFamilies: families });
    const recall = recallBlock(inject.recall);
    const dialectDelivered = inject.dialectDelivered;

    // 工具三层（#333）：热 ∪ 温(页面) ∪ 召回命中 ∪ 闭包。
    const tiers = tieredToolNames({
      hasProduction: !!productionId, pageKey: input.pageKey ?? null, prompt: recallPrompt, recalled, used,
      available: tools.map((t) => t.mcpName),
    });
    const activeToolNames = tiers.active.map(exposedName);

    const harness = new CoreAgentHarness({
      env: NO_ENV,
      session,
      tools,
      activeToolNames,
      // 冷层兜底闭环（补丁 #4）：模型按名调了不在本轮工具面里的工具（find_tools 搜到的，
      // 或它记得的）→ 从注册表临时加载。权限/制作语境仍在工具内部判定，分层≠权限。
      resolveDeferredTool: ({ toolCall }) => toolByName.get(toolCall.name),
      systemPrompt: buildSystemPrompt(inject),
      model: CHAT_MODEL,
      getApiKeyAndHeaders: async () => ({ apiKey: runtimeOverrides.apiKey ?? deepseekApiKey() }),
      runtime: runtimeOverrides.streamFn
        ? { streamSimple: runtimeOverrides.streamFn, completeSimple: llmRuntime().completeSimple }
        : { streamSimple: llmRuntime().streamSimple, completeSimple: llmRuntime().completeSimple },
    });
    active.set(sessionId, {
      runId, harness, abort,
      detach: () => {
        if (detached) return;
        detached = true;
        storage.detach();
        abort.abort();
        void harness.abort().catch(() => {});
      },
    });

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
      const gate = await approvalGate({ runId, sessionId, userId, productionId, tool, toolCallId: event.toolCallId, args: event.input, publisher, signal: abort.signal, isDetached: () => detached });
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
    // 写工具成功 → mutation 行（tools.ts 的 mutates 声明）：跟在 tool-end 后面，同样落 agent_event
    harness.subscribe((event) => {
      adapter(event);
      if (event.type === "tool_execution_start") toolArgs.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
      if (event.type === "tool_execution_end") {
        const args = toolArgs.get(event.toolCallId) ?? {};
        toolArgs.delete(event.toolCallId);
        const def = toolByName.get(event.toolName);
        if (!event.isError && def?.mutates) {
          const m = def.mutates(args);
          if (m) publisher.publish({ type: "mutation", ...m, productionId: productionId ?? null, tool: def.mcpName });
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        usage.input += event.message.usage.input;
        usage.output += event.message.usage.output;
        usage.cacheRead += event.message.usage.cacheRead;
        usage.usd += usdOfUsage(event.message.usage, CHAT_MODEL);
        const t = event.message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
        if (t) lastAssistant = t.slice(0, 2000);
        // 防失控硬顶（#383）：额度判定在 run 开始处、run 内不打断，所以透支上限
        // 就是单个 run 能烧的量。工具死循环会把「允许少量负 credit」变成无底洞——
        // 这道闸不是限流，豁免档同样受它约束。
        const spent = creditsFromUsd(usage.usd);
        if (!abort.signal.aborted && spent > RUN_CREDIT_HARD_CAP) {
          console.error(`[agent-runtime] run ${runId} 触发单轮成本硬顶（${spent} credit > ${RUN_CREDIT_HARD_CAP}），中止`);
          publisher.publish({ type: "error", error: "本次任务消耗异常偏高，已自动中止。请把问题拆小后重试。" });
          abort.abort();
          void active.get(sessionId)?.harness.abort().catch(() => {});
        }
      }
    });

    if (input.message !== undefined) {
      await harness.prompt(input.message);
    } else {
      const decision = await repairAndClassify(session, toolByName, {
        signal: abort.signal,
        canReexecuteWrite: (call) => approvalAllowsReexecute(sessionId, call.id),
      });
      if (decision.kind === "continue") {
        // 审批待答/已批未执行的写工具：重新过确认门（复用同一张卡）后补结果，再续跑
        const gated = decision.repaired.filter((r) => r.action === "await-gate");
        if (gated.length > 0) {
          const ctx = await session.buildContext();
          const lastAssistant = [...ctx.messages].reverse().find((m) => m.role === "assistant");
          const calls = lastAssistant?.role === "assistant"
            ? lastAssistant.content.filter((c): c is ToolCall => c.type === "toolCall" && gated.some((g) => g.toolCallId === c.id))
            : [];
          for (const call of calls) {
            const tool = toolByName.get(call.name)!;
            publisher.publish({ type: "tool", name: call.name, id: call.id, input: call.arguments });
            const gate = await approvalGate({ runId, sessionId, userId, productionId, tool, toolCallId: call.id, args: call.arguments, publisher, signal: abort.signal, isDetached: () => detached });
            let resultText: string;
            let isError = false;
            if (gate?.block) {
              resultText = gate.reason ?? "Tool execution was blocked";
              isError = true;
            } else {
              try {
                const r = await tool.execute(call.id, call.arguments as never, abort.signal);
                resultText = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
              } catch (err) {
                resultText = err instanceof Error ? err.message : String(err);
                isError = true;
              }
            }
            if (detached) return;
            await session.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: resultText }], isError, timestamp: Date.now() });
            publisher.publish({ type: "tool-result", id: call.id, result: resultText, ...(isError ? { isError: true } : {}) });
            publisher.publish({ type: "tool-end", id: call.id });
          }
        }
        await harness.continueTurn();
      } else {
        publisher.publish({ type: "final", text: "" });
      }
    }
    if (abort.signal.aborted) status = "aborted";

    // 自动压缩（agent-core 的 compact() 是手动的；触发由这里驱动，摘要用 pro）
    const compaction = await maybeCompact(harness, session, abort.signal);
    usage.compactionUsd += compaction.usd;
    usage.compactionTokens += compaction.tokens;
  } catch (err) {
    status = abort.signal.aborted ? "aborted" : "failed";
    error = err instanceof Error ? err.message : String(err);
    publisher.publish({ type: "error", error: error || "Agent run did not complete" });
    console.error(`[agent-runtime] run ${runId} failed:`, err);
  } finally {
    clearInterval(heartbeat);
    toolArgs.clear(); // 中止/脱离时可能没有对应的 end 事件
    await publisher.drain();
    if (detached) {
      // 脱离：run 行保持原状态（running/awaiting_*），心跳停更 → 30s 后被下一个进程接管；
      // 已花的 token 照记
      await recordUsage(userId, productionId, usage, input.paidFrom).catch(() => {});
      active.delete(sessionId);
      return;
    }
    await pool.query(
      `UPDATE agent_run SET status = $2, ended_at = now(), error = $3, input_tokens = $4, output_tokens = $5, cache_read_tokens = $6 WHERE id = $1`,
      [runId, status, error, usage.input, usage.output, usage.cacheRead],
    );
    await recordUsage(userId, productionId, usage, input.paidFrom).catch(() => {});
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

function lastUserText(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return textOf(m.content) || null;
  }
  return null;
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

/**
 * 记账（#383 后同时是限流的账本）。
 *
 * token 分三行照记（账本原貌不变），credit 按单价折算后**只挂在 chat_input 行上**：
 * 三行各自折算再相加与整轮成本相等，但那样每行都得知道自己的单价——而
 * provider 报的是整轮的钱。把钱记在一行、token 记在三行，聚合时 SUM 谁都不会重。
 *
 * paidFrom 是 run 开始时定死的：'quota' 进窗口聚合、'extra' 扣余额、'exempt'
 * 两边都不进（豁免 ≠ 不记账，add-plan.sql 的既有约定）。
 */
async function recordUsage(
  userId: string,
  productionId: string | null,
  usage: { input: number; output: number; cacheRead: number; usd: number; compactionUsd: number; compactionTokens: number },
  paidFrom: PaidFrom | undefined,
): Promise<void> {
  const pool = getPool();
  const credits = creditsFromUsd(usage.usd);
  const compactionCredits = creditsFromUsd(usage.compactionUsd);
  // 恢复模式（孤儿接管/审批后续跑）没有开轮判定，这里补一次——不能把豁免项目
  // 的续跑记成 quota。
  const paid = paidFrom ?? (await resolvePaidFrom(userId, productionId));
  const rows: Array<[string, number, number]> = [
    ["chat_input", usage.input, credits],
    ["chat_output", usage.output, 0],
    ["chat_cache_read", usage.cacheRead, 0],
  ];
  let creditsLanded = false;
  for (const [kind, tokens, c] of rows) {
    if (tokens <= 0) continue;
    await pool.query(
      `INSERT INTO ai_usage (user_id, production_id, kind, model, tokens, billed_credits, paid_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, productionId, kind, CHAT_MODEL.id, tokens, c, paid],
    );
    if (c > 0) creditsLanded = true;
  }
  // input=0 而 output>0 的极端形态（全缓存命中）下，钱不能跟着丢
  if (credits > 0 && !creditsLanded) {
    await pool.query(
      `INSERT INTO ai_usage (user_id, production_id, kind, model, tokens, billed_credits, paid_from)
       VALUES ($1, $2, 'chat_input', $3, 0, $4, $5)`,
      [userId, productionId, CHAT_MODEL.id, credits, paid],
    );
  }
  if (usage.compactionTokens > 0 || compactionCredits > 0) {
    await pool.query(
      `INSERT INTO ai_usage (user_id, production_id, kind, model, tokens, billed_credits, paid_from)
       VALUES ($1, $2, 'chat_compaction', $3, $4, $5, $6)`,
      [userId, productionId, COMPACTION_MODEL.id, usage.compactionTokens, compactionCredits, paid],
    );
  }
  const total = credits + compactionCredits;
  if (paid === "extra" && total > 0) {
    await chargeExtraCredits(await quotaOwnerOf(userId, productionId), total).catch((e) =>
      console.error("[agent-runtime] 额外额度扣款失败（用量已记）:", e),
    );
  }
}

async function resolvePaidFrom(userId: string, productionId: string | null): Promise<PaidFrom> {
  return paidFromOf(await getQuotaStatus({ userId, productionId }));
}

// ── 审批门 ───────────────────────────────────────────────────────────────────

interface GateInput {
  runId: string; sessionId: string; userId: string; productionId: string | null;
  tool: RuntimeToolDef; toolCallId: string; args: Record<string, unknown>;
  publisher: { publish: (line: StreamLine) => void }; signal: AbortSignal;
  isDetached: () => boolean;
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
    const { prepareWikiProposal } = await import("@/lib/agent-tools/wiki-proposal-prepare");
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

  // 构作族六个写工具：与执行同一份规划做预览——参数/业务规则错误（如删除方式要用户
  // 二选一）直接 block 回模型、不弹卡；权限三态写进卡片 notes（一个工具横跨多把钥匙）
  let notes: string[] | undefined;
  const { DRAMATURGY_PROPOSE_TOOLS, previewDramaturgyProposal } = await import("@/lib/agent-tools/dramaturgy-tools");
  if (DRAMATURGY_PROPOSE_TOOLS.has(bare) && g.productionId) {
    try {
      const p = await previewDramaturgyProposal(g.userId, g.productionId, bare, g.args);
      if (p.error) return { block: true, reason: `${p.error}（未提交给用户确认）` };
      hasPermission = p.hasPermission;
      notes = p.notes;
    } catch (err) {
      console.error("[agent-runtime] dramaturgy preview failed (card without permission info):", err);
    }
  }

  const card = approvalCard(bare, g.args, { hasPermission, notes });
  const { id, info, reused } = await createApproval({
    runId: g.runId, sessionId: g.sessionId, toolCallId: g.toolCallId, tool: g.tool.name, args: g.args, card, preview,
  });
  await getPool().query(`UPDATE agent_run SET status = 'awaiting_approval' WHERE id = $1`, [g.runId]);
  // 复用的卡不再重发（attach 时 dispatch 会补发待答卡；重发只会在前端多一张）
  if (!reused) g.publisher.publish({ type: "approval", approval: info });

  const outcome = await awaitApproval(id, g.signal, undefined, { isDetached: g.isDetached });
  if (outcome.kind === "detached") return { block: true, reason: "本进程已脱离，审批由下一个进程接管" }; // 不落库：storage 已 detach
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

/**
 * 自动压缩。返回本次压缩的花费（美元与 token），由调用方并进本轮账。
 *
 * 压缩不走 harness 的 message_end，所以它的用量**此前完全没记**——而它用的是
 * v4-pro（3 倍单价）、一次就吃掉整个 transcript。这里把 completeSimple 包一层
 * 取 usage，不必改 vendor（compact 的 runtime 参数是现成的注入点）。
 */
async function maybeCompact(harness: Harness, session: Session, signal: AbortSignal): Promise<CompactionCost> {
  const zero: CompactionCost = { usd: 0, tokens: 0 };
  if (signal.aborted) return zero;
  const ctx = await session.buildContext();
  const { tokens } = estimateContextTokens(ctx.messages);
  if (!shouldCompact(tokens, CHAT_MODEL.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return zero;
  const cost: CompactionCost = { usd: 0, tokens: 0 };
  const rt = llmRuntime();
  const tapped = {
    completeSimple: async (...args: Parameters<typeof rt.completeSimple>) => {
      const msg = await rt.completeSimple(...args);
      if (msg.role === "assistant" && msg.usage) {
        cost.usd += usdOfUsage(msg.usage, COMPACTION_MODEL);
        cost.tokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead;
      }
      return msg;
    },
  };
  const off = harness.on("session_before_compact", async ({ preparation, signal: s }) => {
    const result = await compact(preparation, COMPACTION_MODEL, runtimeOverrides.apiKey ?? deepseekApiKey(), undefined, "用中文写摘要", s, "low", undefined, tapped);
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
  return cost;
}

type CompactionCost = { usd: number; tokens: number };

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
  const r = await getPool().query<{ id: string; title: string | null; updated_at: Date; first_user: string | null; last_text: string | null; active_run: boolean }>(
    `SELECT s.id, s.title, s.updated_at,
       EXISTS (SELECT 1 FROM agent_run r WHERE r.session_id = s.id
                 AND r.status IN ('running', 'awaiting_approval', 'awaiting_answer')) AS active_run,
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
    status: row.active_run ? "running" : "done",
  }));
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await getPool().query(`UPDATE agent_session SET title = $2, updated_at = now() WHERE id = $1`, [sessionId, title]);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await abortRun(sessionId);
  await deleteSessionRows(sessionId);
}

/** 只删行（级联 transcript/run/审批/事件）；中止进行中 run 由调用方经 client 先做。 */
export async function deleteSessionRows(sessionId: string): Promise<void> {
  await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [sessionId]);
}

// ── 重启恢复（§4.4 ①）────────────────────────────────────────────────────────

/** 启动/巡检：接管心跳过期的 run，按中断点修复后续跑。返回接管数。 */
export async function resumeOrphans(): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: string; session_id: string; user_id: string; page_key: string | null }>(
    `UPDATE agent_run r SET owner = $1, heartbeat_at = now(), status = 'running'
     FROM agent_session s
     WHERE r.session_id = s.id
       AND r.status IN ('running', 'awaiting_approval', 'awaiting_answer')
       AND (r.heartbeat_at IS NULL OR r.heartbeat_at < now() - ($2::int * interval '1 millisecond'))
       AND (r.owner IS NULL OR r.owner <> $1)
     RETURNING r.id, r.session_id, s.user_id, r.page_key`,
    [RUNNER_OWNER, ORPHAN_AFTER_MS],
  );
  for (const row of r.rows) {
    if (active.has(row.session_id)) continue;
    const storage = await PgSessionStorage.load(row.session_id);
    if (!storage) continue;
    void execute({ storage, runId: row.id, userId: row.user_id, pageKey: row.page_key });
  }
  return r.rows.length;
}

/** 排水（§4.4 ②）：不再接新 run，等进行中的到自然停点；等待态（审批/提问）的 run
 *  立即脱离交给下一个进程；超时仍没停的也脱离（下一个进程按 ① 恢复）。 */
export async function drain(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pool = getPool();
  while (active.size > 0 && Date.now() < deadline) {
    const ids = [...active.values()].map((r) => r.runId);
    const rows = await pool.query<{ id: string; status: string }>(`SELECT id, status FROM agent_run WHERE id = ANY($1::text[])`, [ids]);
    for (const row of rows.rows) {
      if (row.status === "awaiting_approval" || row.status === "awaiting_answer") {
        const run = [...active.values()].find((r) => r.runId === row.id);
        run?.detach();
      }
    }
    if (active.size === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const run of active.values()) run.detach();
  const settle = Date.now() + 5_000;
  while (active.size > 0 && Date.now() < settle) await new Promise((r) => setTimeout(r, 50));
}

/** 测试用：脱离全部进行中 run（模拟进程消失但不留痕）。 */
export async function detachAll(): Promise<void> {
  for (const run of active.values()) run.detach();
  const settle = Date.now() + 5_000;
  while (active.size > 0 && Date.now() < settle) await new Promise((r) => setTimeout(r, 20));
}

/** 测试用：等待某会话的 run 结束。 */
export async function waitForIdle(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (active.has(sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

export const __internal = { active, execute };
