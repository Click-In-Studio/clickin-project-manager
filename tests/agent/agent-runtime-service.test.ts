import type { Capability, MmpClient } from "@mmp/client";
import { saveModelSelection } from "@/lib/agent/runtime/model-settings-db";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import sharp from "sharp";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { CompactionError } from "../../vendor/openclaw/packages/agent-core/src/harness/types";
import type { AssistantMessage, StreamFn, ToolCall } from "../../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import { makeProduction, setProductionTier, cleanupProduction, makeScene, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent/chat/stream-reducer";
import {
  startRun, steerRun, abortRun, getHistory, listSessions, resumeOrphans, waitForIdle, runtimeOverrides, sessionRunState, __internal,
} from "@/lib/agent/runtime/service";
import { readEventsSince, subscribeSessionEvents } from "@/lib/agent/runtime/events";
import { resolveApproval, approvalSession } from "@/lib/agent/runtime/approvals";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { CHAT_MODEL, llmRuntime, resolveModel } from "@/lib/agent/runtime/config";
import { exposedName } from "@/lib/agent/runtime/tools";
import { TOOL_CATALOG } from "@/lib/agent/tools/tool-catalog";
import { createPendingAttachment, markAttachmentReady } from "@/lib/agent/attachment-db";
import { mutateMemoryEntry, readMemoryScope } from "@/lib/agent/memory/memory-db";

// #367 S2：run 服务端到端（真 DB、假模型、真 harness、真工具函数）。
// 覆盖：事件落表+NOTIFY、历史投影、会话列表、审批门（deny 带理由 / allow）、
// steer、abort、记账、孤儿接管恢复。

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = () => ({ role: "assistant" as const, api: CHAT_MODEL.api, provider: CHAT_MODEL.provider, model: CHAT_MODEL.id, usage: USAGE, timestamp: Date.now() });

type Step = (
  { text: string; thinking?: string; wait?: Promise<void>; stopReason?: "stop" | "length" }
  | { calls: ToolCall[] }
  | { hang: true }
  | { error: string }
) & { before?: () => void | Promise<void>; usage?: AssistantMessage["usage"] };
/** 脚本化假模型；记录每次调用看到的上下文（系统提示、消息、工具名）。 */
function scripted(script: Step[]) {
  const seen: Array<{ systemPrompt?: string; messages: unknown[]; tools: string[]; reasoning?: string; maxTokens?: number }> = [];
  const streamFn: StreamFn = (_model, context, options) => {
    seen.push({ systemPrompt: context.systemPrompt, messages: context.messages, tools: (context.tools ?? []).map((t) => t.name), reasoning: options?.reasoning, maxTokens: options?.maxTokens });
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
    queueMicrotask(async () => {
      await next.before?.();
      if ("error" in next) {
        stream.push({ type: "error", reason: "error", error: { ...base(), content: [], stopReason: "error", errorMessage: next.error } });
        return;
      }
      if ("text" in next && next.wait) await next.wait;
      const final: AssistantMessage = "text" in next
        ? { ...base(), api: _model.api, provider: _model.provider, model: _model.id, content: [...(next.thinking ? [{ type: "thinking" as const, thinking: next.thinking }] : []), { type: "text", text: next.text }], stopReason: next.stopReason ?? "stop" }
        : { ...base(), api: _model.api, provider: _model.provider, model: _model.id, content: next.calls, stopReason: "toolUse" };
      final.usage = next.usage ?? USAGE;
      stream.push({ type: "start", partial: { ...final, content: [] } });
      if ("text" in next) {
        const textIndex = next.thinking ? 1 : 0;
        if (next.thinking) {
          stream.push({ type: "thinking_start", contentIndex: 0, partial: { ...final, content: [{ type: "thinking", thinking: "" }] } });
          let accumulated = "";
          for (const ch of next.thinking) {
            accumulated += ch;
            stream.push({ type: "thinking_delta", contentIndex: 0, delta: ch, partial: { ...final, content: [{ type: "thinking", thinking: accumulated }] } });
          }
          stream.push({ type: "thinking_end", contentIndex: 0, content: next.thinking, partial: { ...final, content: [{ type: "thinking", thinking: next.thinking }] } });
        }
        stream.push({ type: "text_start", contentIndex: textIndex, partial: { ...final, content: [...(next.thinking ? [{ type: "thinking" as const, thinking: next.thinking }] : []), { type: "text", text: "" }] } });
        for (const ch of next.text) stream.push({ type: "text_delta", contentIndex: textIndex, delta: ch });
      }
      stream.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse", message: final });
    });
    return stream;
  };
  return { streamFn, seen };
}

async function collectUntilTerminal(sessionId: string, timeoutMs = 10_000, afterSeq = 0): Promise<StreamLine[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await readEventsSince(sessionId, afterSeq);
    const lines = rows.map((r) => r.line);
    if (lines.some((l) => l.type === "final" || l.type === "aborted" || l.type === "error")) return lines;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("no terminal event");
}

describe("agent-runtime service", () => {
  let userId: string;
  let pendingUserId: string;
  let denyingUserId: string;
  let prodId: string;
  let pendingSceneId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-svc-${shortId()}`, null, false));
    ({ userId: pendingUserId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-perm-${shortId()}`, null, false));
    ({ userId: denyingUserId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-deny-${shortId()}`, null, false));
    const made = await makeProduction(userId);
    await setProductionTier(made.prodId, "pro");
    prodId = made.prodId;
    pendingSceneId = await makeScene(prodId, made.versionId, { number: "1", name: "待改场次" });
    await addProductionMember(prodId, pendingUserId);
    await addProductionMember(prodId, denyingUserId);
    const roleId = `role_${shortId()}`;
    await getPool().query(
      "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, '待激活构作')",
      [roleId, prodId],
    );
    await getPool().query(
      "INSERT INTO production_role_permission (role_id, permission_key) VALUES ($1, 'node:scene/*/synopsis@edit')",
      [roleId],
    );
    await getPool().query(
      "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
      [prodId, pendingUserId, roleId],
    );
    await getPool().query(
      "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
      [prodId, denyingUserId, roleId],
    );
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("EMBEDDING_API_KEY", "test-key");
    runtimeOverrides.apiKey = "test-key";
    // 与 MMP 无关的 runtime 用例不碰 .env.local 指向的真实服务；媒体用例单独开启。
    runtimeOverrides.mmpClient = null;
  });

  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.mmpClient;
    delete runtimeOverrides.compactFn;
    delete runtimeOverrides.shouldCompactFn;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    delete runtimeOverrides.apiKey;
    vi.unstubAllEnvs();
    await cleanupProduction(prodId).catch(() => {});
  });

  function newKey(withProduction = true) {
    const key = createNewSessionKey(userId, withProduction ? prodId : undefined);
    sessions.push(key);
    return key;
  }

  async function seedHistory(key: string) {
    const storage = await PgSessionStorage.create({ id: key, userId, productionId: prodId });
    const session = new Session(storage);
    for (let i = 0; i < 4; i++) {
      await session.appendMessage({ role: "user", content: "旧历史".repeat(3_000), timestamp: i });
      await session.appendMessage({ ...base(), content: [{ type: "text", text: "已处理这批资料" }], stopReason: "stop" });
    }
  }

  it("长上下文的正常工具链超过旧成本阈值仍完成，不因模型返回调用而中途 abort", async () => {
    const { userId } = await upsertFeishuUser(`test-budget-${shortId()}`, "长上下文预算测试", null, false);
    const { prodId } = await makeProduction(userId);
    await setProductionTier(prodId,"pro");
    const key = createNewSessionKey(userId,prodId); sessions.push(key);
    try {
    await PgSessionStorage.create({ id: key,userId,productionId: prodId });
    await getPool().query(`UPDATE agent_session SET model_selection=jsonb_set(model_selection,'{modelKey}','"inspiration"') WHERE id=$1`, [key]);
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const paidUsage = (input: number, output: number, cacheRead: number, usd: number) => ({ input,output,cacheRead,cacheWrite: 0,totalTokens: input+output+cacheRead,cost: { input: usd,output: 0,cacheRead: 0,cacheWrite: 0,total: usd } });
    const fake = scripted([
      { calls: [{ type: "toolCall",id: "cold_read",name: exposedName("my.productions"),arguments: {} }],usage: paidUsage(265953,163,0,0.2000775) },
      { calls: [{ type: "toolCall",id: "cached_read",name: exposedName("my.productions"),arguments: {} }],usage: paidUsage(2428,267,263834,0.0226083) },
      { text: "两次读取均已完成",usage: paidUsage(200,30,264000,0.0200625) },
    ]);
    runtimeOverrides.streamFn = fake.streamFn;
    const { runId } = await startRun({ sessionId: key,userId,message: `核对我的项目。${"历史材料".repeat(66500)}` });
    await waitForIdle(key);
    expect(fake.seen).toHaveLength(3);
    const lines = (await readEventsSince(key,0)).map(row => row.line);
    expect(lines.filter(line => line.type === "tool-end")).toHaveLength(2);
    expect(lines.some(line => line.type === "aborted")).toBe(false);
    expect(lines.at(-1)).toEqual({ type: "final",text: "两次读取均已完成" });
    const run = (await getPool().query("SELECT status,task_credits,task_budget_credits FROM agent_run WHERE id=$1", [runId])).rows[0];
    expect(run.status).toBe("completed");
    expect(Number(run.task_credits)).toBeGreaterThan(500000);
    expect(Number(run.task_budget_credits)).toBeGreaterThan(Number(run.task_credits));
    } finally { await cleanupProduction(prodId).catch(() => {}); }
  });

  it("费用已用尽时完成当前工具，拒绝下一模型请求并保留明确失败原因", async () => {
    const { TASK_COST_LIMIT_CREDITS } = await import("@/lib/agent/runtime/cost-budget");
    const key = newKey();
    const fake = scripted([
      { calls: [{ type: "toolCall",id: "last_allowed_tool",name: exposedName("my.productions"),arguments: {} }],before: async () => {
        await getPool().query("UPDATE agent_run SET task_credits=$2 WHERE session_id=$1 AND status='running'", [key,TASK_COST_LIMIT_CREDITS]);
      } },
      { text: "不应请求" },
    ]);
    runtimeOverrides.streamFn = fake.streamFn;
    const { runId } = await startRun({ sessionId: key,userId,message: "核对我的项目" });
    await waitForIdle(key);
    expect(fake.seen).toHaveLength(1);
    const lines = (await readEventsSince(key,0)).map(row => row.line);
    expect(lines.filter(line => line.type === "tool-end")).toHaveLength(1);
    expect(lines.some(line => line.type === "aborted")).toBe(false);
    const row = (await getPool().query("SELECT status,error FROM agent_run WHERE id=$1", [runId])).rows[0];
    expect(row.status).toBe("failed"); expect(row.error).toContain("task-budget-exceeded");
  });

  it("四次相同工具结果后在下一模型请求前停止，已完成调用均保留", async () => {
    const fake = scripted([...Array.from({ length: 4 }, (_,index) => ({ calls: [{ type: "toolCall" as const,id: `loop_${index}`,name: exposedName("my.productions"),arguments: {} }] })), { text: "不应调用" }]);
    runtimeOverrides.streamFn = fake.streamFn;
    const key = newKey();
    const { runId } = await startRun({ sessionId: key,userId,message: "核对我的项目" });
    await waitForIdle(key);
    expect(fake.seen).toHaveLength(4);
    const lines = (await readEventsSince(key,0)).map(row => row.line);
    expect(lines.filter(line => line.type === "tool-end")).toHaveLength(4);
    expect(lines.some(line => line.type === "aborted")).toBe(false);
    const run = (await getPool().query("SELECT status,error FROM agent_run WHERE id=$1", [runId])).rows[0];
    expect(run.status).toBe("failed");
    expect(run.error).toContain("tool-loop-detected");
  });

  it.each([false, true])("模型错误消息结束（已有工具调用=%s）记为失败，刷新历史保留原因", async (withTool) => {
    const reason = "模型服务当前不可用";
    const script: Step[] = withTool
      ? [{ calls: [{ type: "toolCall", id: "failure_read", name: exposedName("my.productions"), arguments: {} }] }, { error: reason }]
      : [{ error: reason }];
    runtimeOverrides.streamFn = scripted(script).streamFn;
    const key = newKey();
    const { runId } = await startRun({ sessionId: key, userId, message: "读取我的制作" });
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines.at(-1)).toEqual({ type: "error", error: reason });
    expect((await getPool().query("SELECT status,error FROM agent_run WHERE id=$1", [runId])).rows[0])
      .toEqual({ status: "failed", error: reason });
    expect((await getHistory(key)).at(-1)).toEqual({ role: "notice", content: reason });
  });

  it.each(["", "已生成的部分正文"])("长度截断保留正文与思考，终态和重载均报告未完成：%s", async (text) => {
    const { streamFn, seen } = scripted([{ text, thinking: "正在分析材料", stopReason: "length" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    const { runId } = await startRun({ sessionId: key, userId, message: "分析这份材料" });
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(seen).toHaveLength(1);
    expect(seen[0].maxTokens).toBe(256_000);
    expect(lines.at(-1)).toMatchObject({ type: "error", error: expect.stringContaining("尚未完成") });
    expect(lines.some(line => line.type === "final")).toBe(false);
    const row = (await getPool().query("SELECT status,error FROM agent_run WHERE id=$1", [runId])).rows[0];
    expect(row).toEqual({ status: "failed", error: expect.stringContaining("尚未完成") });
    const history = await getHistory(key);
    expect(history).toContainEqual({ role: "thinking", content: "正在分析材料" });
    if (text) expect(history).toContainEqual({ role: "assistant", content: text });
    expect(history.at(-1)).toEqual({ role: "notice", content: row.error });
    const bubbles = lines.reduce<Bubble[]>((all, line) => applyStreamLine(all, line), []);
    expect(bubbles.at(-1)).toEqual({ kind: "notice", text: row.error });
  });

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
    expect(lines.some((line) => line.type === "compacting")).toBe(false);
    expect(notified.length).toBeGreaterThan(0); // NOTIFY 真的到了观看者

    const sess = await getPool().query<{ user_id: string; production_id: string | null }>(`SELECT user_id, production_id FROM agent_session WHERE id = $1`, [key]);
    expect(sess.rows[0]).toEqual({ user_id: userId, production_id: prodId });

    const run = await getPool().query<{ status: string; input_tokens: number; output_tokens: number; owner: string }>(`SELECT status, input_tokens, output_tokens, owner FROM agent_run WHERE id = $1`, [runId]);
    expect(run.rows[0].status).toBe("completed");
    expect(run.rows[0].input_tokens).toBe(7);
    expect(run.rows[0].output_tokens).toBe(3);

    // 按本 run 的时间窗口取记账行：工厂 shortId 在并行 worker 间可能撞出同一个用户
    const usage = await getPool().query<{ kind: string; tokens: number; billed_credits: string; paid_from: string }>(
      `SELECT kind, tokens, billed_credits::text, paid_from FROM ai_usage WHERE user_id = $1 AND kind LIKE 'chat_%'
         AND created_at >= (SELECT started_at FROM agent_run WHERE id = $2) ORDER BY kind`, [userId, runId]);
    expect(usage.rows.map((r) => ({ kind: r.kind, tokens: r.tokens }))).toEqual(
      [{ kind: "chat_input", tokens: 7 }, { kind: "chat_output", tokens: 3 }]);
    // 限流的账（#383）：整轮的钱记在 chat_input 一行上，其余行 0（token 记三行、
    // 钱记一行，聚合才不会重复计）。这一条断言的是**真 run 全链路**——
    // usage → Model.cost → 美元 → credit → 落库；单价表填 0 或折算断链会红。
    // 数值 = 7×$0.3/1M + 3×$1.2/1M，按当前汇率折成 credit = 13。
    expect(Number(usage.rows[0].billed_credits)).toBe(13);
    expect(Number(usage.rows[1].billed_credits)).toBe(0);
    expect(usage.rows.every((r) => r.paid_from === "quota")).toBe(true);

    expect(await getHistory(key)).toEqual([{ role: "user", content: "你好" }, { role: "assistant", content: "你好，我是后台助手" }]);
    // system prompt = 六件套 + 注入包裹（记忆段恒在）；工具面 = 26 个 clickin__ 工具
    expect(seen[0].systemPrompt).toContain("团队 agent 行为规范");
    expect(seen[0].systemPrompt).toContain("<clickin-memory>");
    // 工具三层：制作会话热层在，wiki 族（无页面、无触发词）不在
    expect(seen[0].tools).toContain(exposedName("production.info"));
    expect(seen[0].tools).not.toContain(exposedName("production.wiki_read"));
    expect(seen[0].tools.every((t) => t.startsWith("clickin__"))).toBe(true);
    expect(seen[0].reasoning).toBe("low");

    const list = await listSessions(userId);
    expect(list.find((s) => s.key === key)).toMatchObject({ title: "你好", status: "done" });
    // delta 行已清理，只剩终态
    expect((await readEventsSince(key, 0)).map((r) => r.line.type)).not.toContain("delta");
  });

  it("新生成的音频在同轮温启改名工具，无需确认且卡片、后续推理使用新名称", async () => {
    const key = newKey(false);
    const capability: Capability = {
      id: "test.generate", purpose: "test.generate", visibility: "public", description: "生成测试音频",
      tiers: [{ tier: "cpu", engine: "test", engine_version: "1", cost: "low" }], input: { fields: [{ name: "prompt", kind: "text", required: true, schema: { type: "string" } }] },
      output: { agent_context: "none", fields: [{ name: "audio", kind: "media", required: true,
        produces: ["audio/flac"], cardinality: { min: 1, max: 1 } }] },
    };
    runtimeOverrides.mmpClient = { capabilities: async () => ({ protocol_version: "3.1", capabilities: [{ capability, nodes: ["n1"] }] }) } as unknown as MmpClient;
    let attachmentId = "";
    const bridge = await import("@/lib/agent/tools/mmp-capability-tools");
    const generate = vi.spyOn(bridge, "runCapability").mockImplementation(async (input) => {
      const pending = await createPendingAttachment({
        sessionId: key, userId, fileName: "audio.flac", mimeType: "audio/flac", mediaKind: "audio", fileSize: 12,
        source: { kind: "mmp", runId: input.runId, toolCallId: input.toolCallId, outputName: "audio", outputIndex: 0, metadata: {} },
      });
      const attachment = (await markAttachmentReady(pending.id, key, userId, 12))!;
      attachmentId = attachment.id;
      return { text: `attachmentId=${attachment.id}; audio.flac`, attachments: [attachment], media: [] };
    });
    const renameArgs = { attachmentId: "", fileName: "开场音效" };
    const { streamFn, seen } = scripted([
      { calls: [{ type: "toolCall", id: "generate-audio", name: exposedName("mmp.test.generate"), arguments: { prompt: "开场" } }] },
      { before: () => { renameArgs.attachmentId = attachmentId; }, calls: [{ type: "toolCall", id: "rename-generated-audio", name: exposedName("my.attachment_rename"), arguments: renameArgs }] },
      { text: "已改名为开场音效.flac。" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    try {
      await startRun({ sessionId: key, userId, message: "生成测试音频" });
      const lines = await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(seen[0].tools).not.toContain(exposedName("my.attachment_rename"));
      expect(seen[1].tools).toContain(exposedName("my.attachment_rename"));
      expect(JSON.stringify(seen[2].messages)).toContain("开场音效.flac");
      expect(lines.some((line) => line.type === "approval")).toBe(false);
      expect(lines).toContainEqual(expect.objectContaining({ type: "mutation", scope: "attachment", ids: [attachmentId] }));
      expect(await getHistory(key)).toContainEqual(expect.objectContaining({ role: "tool", id: "generate-audio",
        attachments: [expect.objectContaining({ id: attachmentId, fileName: "开场音效.flac" })] }));
    } finally {
      generate.mockRestore();
      runtimeOverrides.mmpClient = null;
    }
  });

  it("媒体附件在首次模型调用前按 MMP registry 自动预检，agent context 与原件引用同时进入消息", async () => {
    const { streamFn, seen } = scripted([{ text: "已听到" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    const pending = await createPendingAttachment({
      sessionId: key, userId, fileName: "录音.mp4", mimeType: "video/mp4", mediaKind: "audio", fileSize: 12,
    });
    await markAttachmentReady(pending.id, key, userId, 12);
    const oldUrl = process.env.MMP_BASE_URL;
    const oldFetch = globalThis.fetch;
    process.env.MMP_BASE_URL = "https://mmp.test";
    runtimeOverrides.mmpClient = undefined;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/capabilities")) {
        return Response.json({ protocol_version: "3.0", capabilities: [{ nodes: ["test-node"], capability: {
          id: "triage.audio", visibility: "public", purpose: "triage", tiers: [{ tier: "cpu", engine: "test", engine_version: "1", cost: "low" }],
          input: { fields: [{ name: "media", kind: "media", required: true, accepts: ["audio/*"], cardinality: { min: 1, max: 1 } }] },
          output: { fields: [{ name: "digest", kind: "json", required: true, schema: { type: "object" } }], agent_context: "required" },
        } }] });
      }
      const source = { tier: "cpu", engine: "test", engine_version: "1", generated_at: "2026-09-29T00:00:00Z", degraded: false, params: {} };
      return Response.json({
        job_id: `test-node-${pending.id}`, type: "triage.audio", status: "done", media_ids: { media: "sha256:runtime-audio" }, cached: false, source,
        usage: { served_from: "compute", tier: "cpu", engine: "test", compute_ms: 12, wasted_ms: 0 },
        timings_ms: { vad: 3, tagging: 4, asr: 5 },
        outputs: { digest: { kind: "json", value: { media_id: "sha256:runtime-audio", kind: "audio", duration_sec: 1, timeline_unit: "sec",
          segments: [{ start: 0, end: 1, label_status: "ok", labels: [{ tag: "Speech", score: 0.9 }], asr: { text: "帮我记下来", lang: "zh", confidence: 0.9 } }],
          tools: { vad: "ok", tagging: "ok", asr: "ok" }, gaps: [], capabilities_available: [], source } } },
        agent_context: { format: "mmp-agent-context-v1", content_type: "text/plain; charset=utf-8",
          text: "[mmp:agent-context start]\n语音：帮我记下来\n[mmp:agent-context end]" },
      });
    }) as typeof globalThis.fetch;
    try {
      await startRun({ sessionId: key, userId, message: "听一下", attachmentIds: [pending.id] });
      await collectUntilTerminal(key);
      await waitForIdle(key);
      const firstContext = JSON.stringify(seen[0].messages);
      expect(firstContext).toContain("帮我记下来");
      expect(firstContext).toContain(pending.id);
      // registry 生成的一级工具确实进入本 run；近期附件只温启附件入口，不顺带暴露资产入口。
      expect(seen[0].tools).toContain(exposedName("mmp.triage.audio"));
      expect(await getHistory(key)).toEqual([
        { role: "user", content: "听一下", attachments: [{ id: pending.id, fileName: "录音.mp4", mimeType: "video/mp4", mediaKind: "audio" }] },
        { role: "assistant", content: "已听到" },
      ]);
      const mmp = await getPool().query<{ tokens: number }>(
        `SELECT tokens FROM ai_usage WHERE user_id = $1 AND model = 'mmp:triage.audio@cpu' ORDER BY created_at DESC LIMIT 1`, [userId],
      );
      expect(mmp.rows[0]?.tokens).toBe(12);
    } finally {
      globalThis.fetch = oldFetch;
      runtimeOverrides.mmpClient = null;
      if (oldUrl === undefined) delete process.env.MMP_BASE_URL; else process.env.MMP_BASE_URL = oldUrl;
    }
  });

  it("续轮同时保留历史媒体原件与附件生命周期注入，不让后一个 context hook 覆盖媒体恢复", async () => {
    const bytes = await sharp({
      create: { width: 24, height: 16, channels: 3, background: "red" },
    }).jpeg().toBuffer();
    const { streamFn, seen } = scripted([{ text: "看到了" }, { text: "有图片生成能力" }]);
    runtimeOverrides.streamFn = streamFn;
    runtimeOverrides.mmpClient = null;
    const key = newKey(false);
    const pending = await createPendingAttachment({
      sessionId: key, userId, fileName: "reference.jpg", mimeType: "image/jpeg", mediaKind: "image", fileSize: bytes.length,
    });
    await markAttachmentReady(pending.id, key, userId, bytes.length);
    const oldFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
    try {
      await startRun({ sessionId: key, userId, message: "能看到这张图吗", attachmentIds: [pending.id] });
      await collectUntilTerminal(key);
      await waitForIdle(key);
      const lastSeq = Math.max(...(await readEventsSince(key, 0)).map((row) => row.seq));
      await startRun({ sessionId: key, userId, message: "你有图片生成能力吗" });
      await collectUntilTerminal(key, 10_000, lastSeq);
      await waitForIdle(key);
      const secondContext = JSON.stringify(seen[1].messages);
      expect(secondContext).toContain(bytes.toString("base64"));
      expect(secondContext).toContain("<clickin-attachment-lifecycle>");
    } finally {
      vi.stubGlobal("fetch", oldFetch);
    }
  });

  it.each(["deepseek-flash", "resonance"] as const)("#967 大音频后切到 %s 续聊，摘要保留与显式原件重读分别成立", async (targetKey) => {
    const pcmBytes = 8 * 1024 * 1024;
    const wav = Buffer.alloc(44 + pcmBytes);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
    wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcmBytes, 40);
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).jpeg().toBuffer();
    const key = newKey();
    const sound = await createPendingAttachment({ sessionId: key, userId, fileName: "排练.wav", mimeType: "audio/wav", mediaKind: "audio", fileSize: wav.length });
    await markAttachmentReady(sound.id, key, userId, wav.length);
    const picture = targetKey === "resonance" ? await createPendingAttachment({ sessionId: key, userId, fileName: "舞台.jpg", mimeType: "image/jpeg", mediaKind: "image", fileSize: jpeg.length }) : null;
    if (picture) await markAttachmentReady(picture.id, key, userId, jpeg.length);
    const oldFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url) => new Response(new Uint8Array(picture && decodeURIComponent(new URL(String(url)).pathname).includes(picture.r2Key) ? jpeg : wav))));
    const source = resolveModel("inspiration");
    const complete = vi.spyOn(llmRuntime(), "completeSimple").mockResolvedValue({ ...base(), api: source.api, provider: source.provider, model: source.id,
      content: [{ type: "text", text: "开场第二声敲击进入；录音保留，可按 attachmentId 复核。" }], stopReason: "stop" });
    const { streamFn, seen } = scripted([
      { text: "听到开场第二声敲击。" },
      { text: "沿用第二声敲击进入的安排。" },
      { calls: [{ type: "toolCall", id: `reread-${targetKey}`, name: exposedName("my.attachment_read"), arguments: { attachmentId: sound.id } }] },
      { text: "已重新听到原件。" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    try {
      await saveModelSelection(key, userId, { modelKey: "inspiration", thinkingLevel: "low", disabledSubagentModels: [] });
      await startRun({ sessionId: key, userId, message: "听录音，记住开场位置。", attachmentIds: [sound.id] });
      await collectUntilTerminal(key); await waitForIdle(key);
      expect(JSON.stringify(seen[0].messages)).toContain(wav.toString("base64"));
      let cursor = Math.max(...(await readEventsSince(key, 0)).map((row) => row.seq));
      await saveModelSelection(key, userId, { modelKey: targetKey, thinkingLevel: "low", disabledSubagentModels: [] });
      const switched = await startRun({ sessionId: key, userId, message: "继续沿用开场安排。", attachmentIds: picture ? [picture.id] : [] });
      expect((await collectUntilTerminal(key, 10_000, cursor)).at(-1)).toEqual({ type: "final", text: "沿用第二声敲击进入的安排。" });
      await waitForIdle(key);
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0][0].id).toBe(source.id);
      expect(JSON.stringify(complete.mock.calls[0][1].messages)).toContain(wav.toString("base64"));
      expect(JSON.stringify(seen[1].messages)).not.toContain(wav.toString("base64"));
      expect(JSON.stringify(seen[1].messages)).toContain("第二声敲击");
      if (picture) expect(JSON.stringify(seen[1].messages)).toContain(jpeg.toString("base64"));
      expect(seen[1].tools).toContain(exposedName("my.attachment_read"));
      const compactUsage = await getPool().query("SELECT model FROM ai_usage WHERE user_id=$1 AND kind='chat_compaction' AND created_at >= (SELECT started_at FROM agent_run WHERE id=$2)", [userId, switched.runId]);
      expect(compactUsage.rows).toEqual([{ model: source.id }]);
      cursor = Math.max(...(await readEventsSince(key, 0)).map((row) => row.seq));
      await saveModelSelection(key, userId, { modelKey: "inspiration", thinkingLevel: "low", disabledSubagentModels: [] });
      await startRun({ sessionId: key, userId, message: "请重读录音原件复核，不只依据摘要。" });
      expect((await collectUntilTerminal(key, 10_000, cursor)).at(-1)).toEqual({ type: "final", text: "已重新听到原件。" });
      await waitForIdle(key);
      expect(JSON.stringify(seen[2].messages)).not.toContain(wav.toString("base64"));
      expect(JSON.stringify(seen[3].messages)).toContain(wav.toString("base64"));
      expect(seen[3].tools).not.toContain(exposedName("my.attachment_read"));
      expect(complete).toHaveBeenCalledOnce();
      const persisted = await getPool().query("SELECT payload FROM agent_session_entry WHERE session_id=$1", [key]);
      expect(JSON.stringify(persisted.rows)).not.toContain(wav.toString("base64"));
    } finally { complete.mockRestore(); vi.stubGlobal("fetch", oldFetch); }
  });

  it("#967 显式原件读取先整理拥挤历史，原件在下一次模型请求中保留", async () => {
    const key = newKey();
    await seedHistory(key);
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
    const attachment = await createPendingAttachment({ sessionId: key, userId, fileName: "原件.png", mimeType: "image/png", mediaKind: "image", fileSize: bytes.length });
    await markAttachmentReady(attachment.id, key, userId, bytes.length);
    const oldFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
    const complete = vi.spyOn(llmRuntime(), "completeSimple").mockResolvedValue({ ...base(), content: [{ type: "text", text: "之前的材料已处理；继续复核原件。" }], stopReason: "stop" });
    let checks = 0;
    runtimeOverrides.shouldCompactFn = () => ++checks === 2;
    const { streamFn, seen } = scripted([{ calls: [{ type: "toolCall", id: "native-read-with-compaction", name: exposedName("my.attachment_read"), arguments: { attachmentId: attachment.id } }] }, { text: "已看见原件" }]);
    runtimeOverrides.streamFn = streamFn;
    try {
      await startRun({ sessionId: key, userId, message: "请读取附件原件复核。" });
      expect((await collectUntilTerminal(key)).at(-1)).toEqual({ type: "final", text: "已看见原件" });
      await waitForIdle(key);
      expect(complete).toHaveBeenCalledOnce();
      expect(JSON.stringify(complete.mock.calls[0][1].messages)).not.toContain(bytes.toString("base64"));
      expect(JSON.stringify(seen[1].messages)).toContain(bytes.toString("base64"));
      expect(seen[1].tools).not.toContain(exposedName("my.attachment_read"));
      const entries = (await getPool().query("SELECT type,payload FROM agent_session_entry WHERE session_id=$1 ORDER BY seq", [key])).rows;
      expect(entries.findIndex((entry) => entry.type === "compaction")).toBeLessThan(entries.findIndex((entry) => entry.payload.message?.toolCallId === "native-read-with-compaction"));
    } finally { complete.mockRestore(); delete runtimeOverrides.shouldCompactFn; vi.stubGlobal("fetch", oldFetch); }
  });

  it("thinking 写入 transcript、历史可恢复，run 结束后累计事件被清理", async () => {
    const { streamFn } = scripted([{ thinking: "先检查已有信息", text: "可以开始" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();

    await startRun({ sessionId: key, userId, message: "开始吧" });
    await collectUntilTerminal(key);
    await waitForIdle(key);

    expect(await getHistory(key)).toEqual([
      { role: "user", content: "开始吧" },
      { role: "thinking", content: "先检查已有信息" },
      { role: "assistant", content: "可以开始" },
    ]);
    const retainedTypes = (await readEventsSince(key, 0)).map((r) => r.line.type);
    expect(retainedTypes).not.toContain("thinking");
    expect(retainedTypes).not.toContain("delta");
    expect(retainedTypes).toContain("final");
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
    expect(new Set(seen.map((request) => request.systemPrompt)).size).toBe(1);
    expect(seen[1].tools).toEqual(seen[0].tools);
    expect(seen[2].tools).toEqual(seen[0].tools);
    const instr = await getPool().query(`SELECT content FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    expect(instr.rows).toHaveLength(0);
    expect(lines.some((l) => l.type === "mutation")).toBe(false); // 被拒的写工具没有变更信号
  });

  it("审批 allow → 写工具真执行（个人指令被写入），approval-resolved 行到前端", async () => {
    const writeCall: ToolCall = { type: "toolCall", id: "c_w2", name: exposedName("my.update_instructions"), arguments: { content: "回复末尾加一个🎭" } };
    const { streamFn, seen } = scripted([{ calls: [writeCall] }, { text: "已更新" }]);
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
    expect(lines[endIdx + 1]).toMatchObject({ type: "mutation", scope: "instructions.personal", action: "updated", productionId: null, tool: "my.update_instructions" });
    // 写审计（agent_mutation）真落了行 → mutation 行带账本 id 与人话摘要（前端渲成 notice）
    const mutation = lines[endIdx + 1] as Extract<StreamLine, { type: "mutation" }>;
    expect(mutation.auditIds?.[0]?.startsWith("am_")).toBe(true);
    expect(mutation.summary).toContain("更新个人 AI 指令");
    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    expect(bubbles.some((b) => b.kind === "notice" && b.text.startsWith("✏️ 更新个人 AI 指令"))).toBe(true);
    const audit = await getPool().query<{ run_id: string | null; tool_call_id: string }>(`SELECT run_id, tool_call_id FROM agent_mutation WHERE id = $1`, [mutation.auditIds![0]]);
    expect(audit.rows[0]).toMatchObject({ tool_call_id: "c_w2" });
    expect(audit.rows[0].run_id).not.toBeNull();
    const instr = await getPool().query<{ content: string }>(`SELECT content FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    expect(instr.rows[0]?.content).toBe("回复末尾加一个🎭");
    expect(seen[1].systemPrompt).toContain("回复末尾加一个🎭");
    await getPool().query(`DELETE FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]);
    const approval = await getPool().query<{ status: string; executed_at: Date | null }>(`SELECT status, executed_at FROM agent_approval WHERE id = $1`, [approvalId]);
    expect(approval.rows[0].status).toBe("allowed");
    expect(approval.rows[0].executed_at).not.toBeNull();
  });

  it("每次模型请求刷新权威前缀：当前指令、记忆删除和项目资格立即生效，工具顺序保持稳定", async () => {
    const directive = `本轮旧指令-${shortId()}`;
    const deletedMemory = `本轮删除记忆-${shortId()}`;
    const projectMemory = `失去资格后不可见-${shortId()}`;
    await getPool().query(
      `INSERT INTO agent_instructions(scope_type,scope_id,content,updated_by)
       VALUES('user',$1::text,$2,$1::uuid)
       ON CONFLICT(scope_type,scope_id) DO UPDATE SET content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [pendingUserId, directive],
    );
    const generalId = await mutateMemoryEntry(pendingUserId, null, { action: "create", body: deletedMemory, actor: "user" });
    const projectId = await mutateMemoryEntry(pendingUserId, prodId, { action: "create", body: projectMemory, actor: "user" });
    const general = (await readMemoryScope(pendingUserId, null)).entries.find((entry) => entry.id === generalId)!;
    const readCall: ToolCall = { type: "toolCall", id: "c_refresh_authority", name: exposedName("production.info"), arguments: {} };
    const { streamFn, seen } = scripted([
      {
        calls: [readCall],
        before: async () => {
          await mutateMemoryEntry(pendingUserId, null, { action: "delete", id: generalId, revision: general.revision, actor: "user" });
          await getPool().query(`DELETE FROM agent_instructions WHERE scope_type='user' AND scope_id=$1`, [pendingUserId]);
          await getPool().query(
            `UPDATE production_member SET status='exited',status_source='self' WHERE production_id=$1 AND user_id=$2`,
            [prodId, pendingUserId],
          );
        },
      },
      { text: "已按当前状态继续" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(pendingUserId, prodId);
    sessions.push(key);
    try {
      await startRun({ sessionId: key, userId: pendingUserId, message: "我参与哪些制作" });
      await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(seen).toHaveLength(2);
      expect(seen[0].systemPrompt).toContain(directive);
      expect(seen[0].systemPrompt).toContain(deletedMemory);
      expect(seen[0].systemPrompt).toContain(projectMemory);
      expect(seen[1].systemPrompt).not.toContain(directive);
      expect(seen[1].systemPrompt).not.toContain(deletedMemory);
      expect(seen[1].systemPrompt).not.toContain(projectMemory);
      expect(seen[1].tools).toEqual(seen[0].tools);
      const secondMessages = JSON.stringify(seen[1].messages);
      expect(secondMessages).toContain("权限被拒绝：你不是该制作的成员");
      expect((secondMessages.match(/<clickin-recall>/g) ?? [])).toHaveLength(1);
    } finally {
      await getPool().query(
        `UPDATE production_member SET status='active',status_source=NULL WHERE production_id=$1 AND user_id=$2`,
        [prodId, pendingUserId],
      );
      const project = (await readMemoryScope(pendingUserId, prodId)).entries.find((entry) => entry.id === projectId);
      if (project) await mutateMemoryEntry(pendingUserId, prodId, { action: "delete", id: project.id, revision: project.revision, actor: "user" });
      await getPool().query(`DELETE FROM agent_instructions WHERE scope_type='user' AND scope_id=$1`, [pendingUserId]);
    }
  });

  it("写工具完成后的模型请求超窗只重放模型请求，不重复业务写入", async () => {
    const content = `只写一次-${shortId()}`;
    const writeCall: ToolCall = {
      type: "toolCall",
      id: "c_write_before_overflow",
      name: exposedName("my.update_instructions"),
      arguments: { content },
    };
    runtimeOverrides.shouldCompactFn = () => false;
    runtimeOverrides.compactFn = async (preparation) => ({
      ok: true,
      value: {
        summary: "用户已确认并完成一次个人指令更新。",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    });
    const { streamFn, seen } = scripted([
      { calls: [writeCall] },
      { error: "context_length_exceeded: maximum context length exceeded" },
      { text: "已完成且没有重复写入" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey(false);
    try {
      const { runId } = await startRun({
        sessionId: key,
        userId,
        message: `把这条个人指令写入一次。背景材料：${"旧上下文".repeat(15_000)}`,
      });
      let approvalId: string | undefined;
      for (let i = 0; i < 200 && !approvalId; i++) {
        const line = (await readEventsSince(key, 0)).map((row) => row.line)
          .find((item) => item.type === "approval") as Extract<StreamLine, { type: "approval" }> | undefined;
        approvalId = line?.approval?.id;
        if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(approvalId).toBeTruthy();
      await resolveApproval(approvalId!, "allow-once", userId);
      const lines = await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(lines.at(-1)).toEqual({ type: "final", text: "已完成且没有重复写入" });
      expect(seen).toHaveLength(3);
      expect(lines.filter((line) => line.type === "tool-end" && line.id === writeCall.id)).toHaveLength(1);
      expect((await getPool().query(
        `SELECT count(*)::int AS n FROM agent_mutation WHERE run_id=$1 AND tool_call_id=$2`,
        [runId, writeCall.id],
      )).rows[0].n).toBe(1);
      expect((await getPool().query<{ content: string }>(
        `SELECT content FROM agent_instructions WHERE scope_type='user' AND scope_id=$1`,
        [userId],
      )).rows[0]?.content).toBe(content);
    } finally {
      await getPool().query(`DELETE FROM agent_instructions WHERE scope_type='user' AND scope_id=$1`, [userId]);
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("写工具命中 🔓：inline 激活 → 权限 mutation → 原写确认 → 执行", async () => {
    const writeCall: ToolCall = {
      type: "toolCall",
      id: "c_activate_permission",
      name: exposedName("production.scene_propose_update"),
      arguments: { updates: [{ sceneId: pendingSceneId, synopsis: "激活后写入" }], summary: "补充梗概" },
    };
    const { streamFn } = scripted([{ calls: [writeCall] }, { text: "已完成" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(pendingUserId, prodId);
    sessions.push(key);
    await startRun({ sessionId: key, userId: pendingUserId, message: "帮我修改这场的构作梗概" });

    let activation: Extract<StreamLine, { type: "approval" }> | undefined;
    for (let i = 0; i < 200 && !activation; i++) {
      activation = (await readEventsSince(key, 0)).map((r) => r.line).find(
        (line): line is Extract<StreamLine, { type: "approval" }> =>
          line.type === "approval" && line.approval?.purpose === "permission-activation",
      );
      if (!activation) await new Promise((r) => setTimeout(r, 25));
    }
    expect(activation?.approval?.description).toContain("编辑章节/段落梗概");
    await resolveApproval(activation!.approval!.id, "allow-once", pendingUserId);

    let writeApproval: Extract<StreamLine, { type: "approval" }> | undefined;
    for (let i = 0; i < 200 && !writeApproval; i++) {
      writeApproval = (await readEventsSince(key, 0)).map((r) => r.line).find(
        (line): line is Extract<StreamLine, { type: "approval" }> =>
          line.type === "approval" && line.approval?.purpose !== "permission-activation",
      );
      if (!writeApproval) await new Promise((r) => setTimeout(r, 25));
    }
    expect(writeApproval?.approval?.id).not.toBe(activation?.approval?.id);
    const interim = (await readEventsSince(key, 0)).map((r) => r.line);
    expect(interim).toContainEqual(expect.objectContaining({
      type: "mutation", scope: "permissions", action: "updated", productionId: prodId,
    }));
    const grant = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'scene'
         AND resource_id = '*' AND resource_sub = 'synopsis' AND permission_level = 'edit' AND is_revoked = false`,
      [prodId, pendingUserId],
    );
    expect(grant.rowCount).toBe(1);

    await resolveApproval(writeApproval!.approval!.id, "allow-once", pendingUserId);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(lines.filter((line) => line.type === "approval")).toHaveLength(2);
    expect(lines).toContainEqual(expect.objectContaining({ type: "mutation", scope: "scene", action: "updated" }));
    const scene = await getPool().query<{ synopsis: string }>(
      "SELECT synopsis FROM scene_version WHERE scene_id = $1 AND version_id = (SELECT active_version_id FROM production WHERE id = $2)",
      [pendingSceneId, prodId],
    );
    expect(scene.rows[0]?.synopsis).toBe("激活后写入");
  });

  it("权限激活选择暂不激活：不落 grant、不出现写确认、不执行", async () => {
    const writeCall: ToolCall = {
      type: "toolCall",
      id: "c_deny_activation",
      name: exposedName("production.scene_propose_update"),
      arguments: { updates: [{ sceneId: pendingSceneId, synopsis: "不应写入" }], summary: "测试拒绝激活" },
    };
    const { streamFn, seen } = scripted([{ calls: [writeCall] }, { text: "没有修改" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(denyingUserId, prodId);
    sessions.push(key);
    await startRun({ sessionId: key, userId: denyingUserId, message: "修改构作梗概" });

    let activation: Extract<StreamLine, { type: "approval" }> | undefined;
    for (let i = 0; i < 200 && !activation; i++) {
      activation = (await readEventsSince(key, 0)).map((r) => r.line).find(
        (line): line is Extract<StreamLine, { type: "approval" }> =>
          line.type === "approval" && line.approval?.purpose === "permission-activation",
      );
      if (!activation) await new Promise((r) => setTimeout(r, 25));
    }
    await resolveApproval(activation!.approval!.id, "deny", denyingUserId);
    const lines = await collectUntilTerminal(key);
    await waitForIdle(key);

    expect(lines.filter((line) => line.type === "approval")).toHaveLength(1);
    expect(lines.some((line) => line.type === "mutation")).toBe(false);
    expect(seen[1].messages.some((message) => JSON.stringify(message).includes("用户暂未激活权限"))).toBe(true);
    const grants = await getPool().query(
      "SELECT 1 FROM production_member_grant WHERE production_id = $1 AND user_id = $2 AND grant_source = 'self_confirmed' AND is_revoked = false",
      [prodId, denyingUserId],
    );
    expect(grants.rowCount).toBe(0);
    const scene = await getPool().query<{ synopsis: string }>(
      "SELECT synopsis FROM scene_version WHERE scene_id = $1 AND version_id = (SELECT active_version_id FROM production WHERE id = $2)",
      [pendingSceneId, prodId],
    );
    expect(scene.rows[0]?.synopsis).toBe("激活后写入");
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

  it("完整历史压缩只请求一次摘要，沿用原请求头并独立记账", async () => {
    const complete = vi.spyOn(llmRuntime(), "completeSimple").mockResolvedValue({
      ...base(), content: [{ type: "text", text: "旧材料已经处理，保留当前用户目标。" }], stopReason: "stop",
    });
    let checks = 0;
    runtimeOverrides.shouldCompactFn = () => checks++ === 0;
    runtimeOverrides.streamFn = scripted([{ text: "执行完毕" }]).streamFn;
    const key = newKey();
    await seedHistory(key);
    try {
      const usageCursor = Number((await getPool().query("SELECT COALESCE(max(id),0) AS id FROM ai_usage")).rows[0].id);
      const started = await startRun({ sessionId: key, userId, message: "继续处理新材料" });
      const lines = await collectUntilTerminal(key); await waitForIdle(key);
      expect(lines.at(-1)).toEqual({ type: "final", text: "执行完毕" });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0][1].systemPrompt).toContain("Click-In");
      expect(JSON.stringify(complete.mock.calls[0][1].messages)).toContain("旧历史");
      const observations = (await getPool().query("SELECT data,ended_at FROM agent_observation WHERE run_id=$1 ORDER BY started_at", [started.runId])).rows;
      const requests = observations.filter(row => row.data.purpose === "compaction");
      expect(requests).toHaveLength(1);
      expect(requests[0].ended_at).toBeTruthy();
      expect(requests[0].data.stopReason).toBe("stop");
      expect(observations.some(row => row.data.triggered === true && row.data.status === "ok")).toBe(true);
      expect((await getPool().query(
        "SELECT kind,model,tokens FROM ai_usage WHERE id>$1 AND user_id=$2 AND kind='chat_compaction'",
        [usageCursor, userId],
      )).rows).toEqual([{ kind: "chat_compaction", model: CHAT_MODEL.id, tokens: 10 }]);
      expect(Number((await getPool().query("SELECT task_credits FROM agent_run WHERE id=$1", [started.runId])).rows[0].task_credits)).toBeGreaterThan(0);
    } finally { complete.mockRestore(); delete runtimeOverrides.shouldCompactFn; }
  });

  it("连续工具调用在下一次模型请求前压缩，并保留调用与结果配对", async () => {
    let checks = 0;
    runtimeOverrides.shouldCompactFn = () => checks++ === 1;
    runtimeOverrides.compactFn = async (preparation) => ({
      ok: true,
      value: {
        summary: "用户要求读取其参与的项目，工具调用已经完成。",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    });
    const readCall: ToolCall = {
      type: "toolCall",
      id: "c_compact_between_steps",
      name: exposedName("my.productions"),
      arguments: {},
    };
    const { streamFn, seen } = scripted([{ calls: [readCall] }, { text: "读取完成" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    await seedHistory(key);
    try {
      await startRun({ sessionId: key, userId, message: `请读取我的项目。${"历史说明".repeat(15_000)}` });
      const lines = await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(lines.at(-1)).toEqual({ type: "final", text: "读取完成" });
      expect(seen).toHaveLength(2);
      const second = JSON.stringify(seen[1].messages);
      expect(second).toContain("c_compact_between_steps");
      expect(second).toContain("toolResult");
      expect((await getPool().query(
        "SELECT count(*)::int AS n FROM agent_session_entry WHERE session_id=$1 AND type='compaction'",
        [key],
      )).rows[0].n).toBe(1);
    } finally {
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("压缩期间输入先持久化，压缩后作为 steer 消费，终态最后发出", async () => {
    let compactStarted!: () => void;
    const started = new Promise<void>((resolve) => { compactStarted = resolve; });
    let finishCompact!: () => void;
    const compactGate = new Promise<void>((resolve) => { finishCompact = resolve; });
    let checks = 0;
    runtimeOverrides.shouldCompactFn = () => checks++ === 0;
    runtimeOverrides.compactFn = async (preparation) => {
      compactStarted();
      await compactGate;
      return {
        ok: true,
        value: {
          summary: "已压缩的旧上下文",
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    };
    const { streamFn, seen } = scripted([{ text: "第一段正文" }, { text: "压缩后收到补充" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    await seedHistory(key);

    try {
      await startRun({ sessionId: key, userId, message: "继续处理这条" });
      await started;
      expect((await getPool().query(`SELECT status FROM agent_run WHERE session_id = $1`, [key])).rows[0].status).toBe("compacting");
      expect((await readEventsSince(key, 0)).map((row) => row.line.type)).not.toContain("final");

      expect(await steerRun(key, "压缩完成后继续处理这条")).toMatchObject({ runId: expect.any(String) });
      expect((await getPool().query(
        `SELECT count(*)::int AS n FROM agent_session_inbox WHERE session_id = $1 AND message = $2`,
        [key, "压缩完成后继续处理这条"],
      )).rows[0].n).toBe(1);
      expect(await getHistory(key)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "压缩完成后继续处理这条" }),
      ]));

      finishCompact();
      await collectUntilTerminal(key);
      await waitForIdle(key);
      const lines = (await readEventsSince(key, 0)).map((row) => row.line);
      const types = lines.map((line) => line.type);
      expect(types.indexOf("compacting")).toBeLessThan(types.lastIndexOf("final"));
      expect(lines.filter((line) => line.type === "compacting")).toEqual([
        { type: "compacting", active: true },
        { type: "compacting", active: false },
      ]);
      expect(seen).toHaveLength(2);
      expect(JSON.stringify(seen[1].messages)).toContain("压缩完成后继续处理这条");
      expect((await getPool().query(`SELECT count(*)::int AS n FROM agent_session_inbox WHERE session_id = $1`, [key])).rows[0].n).toBe(0);
      const persisted = await getPool().query<{ entry_id: string }>(
        `SELECT entry_id FROM agent_session_entry
          WHERE session_id = $1 AND payload->'message'->>'role' = 'user'
            AND payload->'message'->'content'->0->>'text' LIKE '压缩完成后继续处理这条%'`,
        [key],
      );
      expect(persisted.rows[0]?.entry_id).toMatch(/^ain_/);
      expect((await getPool().query(
        `SELECT count(*)::int AS n FROM agent_session_entry WHERE session_id = $1 AND type = 'compaction'`,
        [key],
      )).rows[0].n).toBe(1);
    } finally {
      finishCompact();
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("压缩失败会清掉 compacting 状态并按原正文正常收尾", async () => {
    let checks = 0;
    runtimeOverrides.shouldCompactFn = () => checks++ === 0;
    runtimeOverrides.compactFn = async () => ({
      ok: false,
      error: new CompactionError("summarization_failed", "摘要服务暂时不可用"),
    });
    runtimeOverrides.streamFn = scripted([{ text: "正文仍然有效" }]).streamFn;
    const key = newKey();
    await seedHistory(key);
    try {
      const { runId } = await startRun({ sessionId: key, userId, message: `长会话${"内容".repeat(20_000)}` });
      await collectUntilTerminal(key);
      await waitForIdle(key);
      const lines = (await readEventsSince(key, 0)).map((row) => row.line);
      expect(lines.filter((line) => line.type === "compacting")).toEqual([
        { type: "compacting", active: true },
        { type: "compacting", active: false },
      ]);
      expect(lines.at(-1)).toEqual({ type: "final", text: "正文仍然有效" });
      expect((await getPool().query(`SELECT status FROM agent_run WHERE id = $1`, [runId])).rows[0].status).toBe("completed");
    } finally {
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("压缩进行中取消：不提交摘要，清掉 compacting 并以 aborted 收口", async () => {
    let compactStarted!: () => void;
    const started = new Promise<void>((resolve) => { compactStarted = resolve; });
    runtimeOverrides.shouldCompactFn = () => true;
    runtimeOverrides.compactFn = async (...args) => {
      compactStarted();
      const signal = args[6];
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: false, error: new CompactionError("aborted", "用户停止") };
    };
    runtimeOverrides.streamFn = scripted([{ text: "不应发送" }]).streamFn;
    const key = newKey();
    await seedHistory(key);
    try {
      const { runId } = await startRun({ sessionId: key, userId, message: "等待这次压缩" });
      await started;
      expect(await abortRun(key)).toBe(true);
      const lines = await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(lines.at(-1)?.type).toBe("aborted");
      expect(lines.filter((line) => line.type === "compacting")).toEqual([
        { type: "compacting", active: true },
        { type: "compacting", active: false },
      ]);
      expect((await getPool().query(
        `SELECT count(*)::int AS n FROM agent_session_entry WHERE session_id=$1 AND type='compaction'`,
        [key],
      )).rows[0].n).toBe(0);
      expect((await getPool().query(`SELECT status FROM agent_run WHERE id=$1`, [runId])).rows[0].status).toBe("aborted");
    } finally {
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("provider 明确报上下文超限时，只有持久压缩确实缩短后才重试一次", async () => {
    runtimeOverrides.shouldCompactFn = () => false;
    runtimeOverrides.compactFn = async (preparation) => ({
      ok: true,
      value: {
        summary: "保留用户目标与关键进度。",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    });
    const { streamFn, seen } = scripted([
      { text: "先保存这段历史" },
      { error: "context_length_exceeded: maximum context length exceeded" },
      { text: "压缩后恢复" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    try {
      await startRun({ sessionId: key, userId, message: `长会话${"内容".repeat(20_000)}` });
      await collectUntilTerminal(key);
      await waitForIdle(key);
      const cursor = (await readEventsSince(key, 0)).at(-1)?.seq ?? 0;
      const { runId } = await startRun({ sessionId: key, userId, message: "继续处理" });
      const lines = await collectUntilTerminal(key, 10_000, cursor);
      await waitForIdle(key);
      expect(lines.at(-1)).toEqual({ type: "final", text: "压缩后恢复" });
      expect(seen).toHaveLength(3);
      expect(JSON.stringify(seen[2].messages).length).toBeLessThan(JSON.stringify(seen[1].messages).length);
      expect((await getPool().query(
        "SELECT count(*)::int AS n FROM agent_session_entry WHERE session_id=$1 AND type='compaction'",
        [key],
      )).rows[0].n).toBe(1);
      expect((await getPool().query<{ status: string }>(
        "SELECT data->>'status' AS status FROM agent_observation WHERE run_id=$1 AND data->>'purpose'='chat' ORDER BY started_at",
        [runId],
      )).rows.map((row) => row.status)).toEqual(["context_overflow", "stop"]);
    } finally {
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("上下文超限后的压缩没有进展时不重放模型请求", async () => {
    runtimeOverrides.shouldCompactFn = () => false;
    runtimeOverrides.compactFn = async () => ({
      ok: false,
      error: new CompactionError("not_smaller", "摘要没有缩短上下文"),
    });
    const { streamFn, seen } = scripted([
      { error: "context_length_exceeded: maximum context length exceeded" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    try {
      await startRun({ sessionId: key, userId, message: `长会话${"内容".repeat(20_000)}` });
      const lines = await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(seen).toHaveLength(1);
      expect(lines.at(-1)?.type).toBe("error");
    } finally {
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("上下文超限恢复达到一次上限后明确失败，不继续循环", async () => {
    runtimeOverrides.shouldCompactFn = () => false;
    runtimeOverrides.compactFn = async (preparation) => ({
      ok: true,
      value: {
        summary: "已经缩短一次的上下文。",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    });
    const { streamFn, seen } = scripted([
      { text: "先保存历史" },
      { error: "context_length_exceeded: maximum context length exceeded" },
      { error: "context_length_exceeded: maximum context length exceeded" },
    ]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    try {
      await startRun({ sessionId: key, userId, message: `长会话${"内容".repeat(20_000)}` });
      await collectUntilTerminal(key);
      await waitForIdle(key);
      const cursor = (await readEventsSince(key, 0)).at(-1)?.seq ?? 0;
      await startRun({ sessionId: key, userId, message: "继续" });
      const lines = await collectUntilTerminal(key, 10_000, cursor);
      await waitForIdle(key);
      expect(seen).toHaveLength(3);
      expect(lines.at(-1)?.type).toBe("error");
    } finally {
      delete runtimeOverrides.compactFn;
      delete runtimeOverrides.shouldCompactFn;
    }
  });

  it("带附件 steer 立即确认入队，MMP 预检异步完成后才把 agent context 注入下一次模型调用", async () => {
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseCapabilities!: () => void;
    const capabilityWait = new Promise<void>((resolve) => { releaseCapabilities = resolve; });
    const { streamFn, seen } = scripted([{ text: "第一轮", wait: firstWait }, { text: "收到附件插话" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    const pending = await createPendingAttachment({
      sessionId: key, userId, fileName: "补充.m4a", mimeType: "audio/mp4", mediaKind: "audio", fileSize: 12,
    });
    await markAttachmentReady(pending.id, key, userId, 12);
    const oldUrl = process.env.MMP_BASE_URL;
    const oldFetch = globalThis.fetch;
    process.env.MMP_BASE_URL = "https://mmp-runtime-steer.test";
    runtimeOverrides.mmpClient = undefined;
    let jobs = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/capabilities")) {
        await capabilityWait;
        return Response.json({ protocol_version: "3.0", capabilities: [{ nodes: ["test-node"], capability: {
          id: "triage.audio", visibility: "public", purpose: "triage", tiers: [{ tier: "cpu", engine: "test", engine_version: "1", cost: "low" }],
          input: { fields: [{ name: "media", kind: "media", required: true, accepts: ["audio/*"], cardinality: { min: 1, max: 1 } }] },
          output: { fields: [{ name: "digest", kind: "json", required: true, schema: { type: "object" } }], agent_context: "required" },
        } }] });
      }
      jobs++;
      const source = { tier: "cpu", engine: "test", engine_version: "1", generated_at: "2026-09-29T00:00:00Z", degraded: false, params: {} };
      return Response.json({
        job_id: "test-node-steer", type: "triage.audio", status: "done", media_ids: { media: "sha256:steer-audio" }, cached: true, source,
        outputs: { digest: { kind: "json", value: { media_id: "sha256:steer-audio", kind: "audio", duration_sec: 1, timeline_unit: "sec",
          segments: [{ start: 0, end: 1, label_status: "ok", labels: [{ tag: "Speech", score: 0.9 }], asr: { text: "这是补充说明", lang: "zh", confidence: 0.9 } }],
          tools: { vad: "ok", tagging: "ok", asr: "ok" }, gaps: [], capabilities_available: [], source } } },
        agent_context: { format: "mmp-agent-context-v1", content_type: "text/plain; charset=utf-8",
          text: "[mmp:agent-context start]\n语音：这是补充说明\n[mmp:agent-context end]" },
      });
    }) as typeof globalThis.fetch;
    try {
      await startRun({ sessionId: key, userId, message: "先回答" });
      for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const queued = await Promise.race([
        steerRun(key, "再听这个", [pending.id]),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      expect(queued).not.toBe("timeout");
      expect(jobs).toBe(0);
      releaseCapabilities();
      for (let i = 0; i < 100 && jobs === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      releaseFirst();
      await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(JSON.stringify(seen[1]?.messages)).toContain("这是补充说明");
      expect(JSON.stringify(seen[1]?.messages)).toContain(pending.id);
    } finally {
      releaseCapabilities();
      releaseFirst();
      globalThis.fetch = oldFetch;
      runtimeOverrides.mmpClient = null;
      if (oldUrl === undefined) delete process.env.MMP_BASE_URL; else process.env.MMP_BASE_URL = oldUrl;
    }
  });

  it("孤儿接管：心跳过期的 running run 被新执行者接管并从 transcript 续跑", async () => {
    const { streamFn } = scripted([{ text: "接管后续上" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = newKey();
    // 手工制造"上一个进程死了"的状态：会话 + 一条用户消息 + running 且心跳过期的 run
    const { PgSessionStorage } = await import("@/lib/agent/runtime/pg-session-storage");
    const { Session } = await import("../../vendor/openclaw/packages/agent-core/src/harness/session/session");
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
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("EMBEDDING_API_KEY", "test-key");
    runtimeOverrides.apiKey = "test-key";
    runtimeOverrides.mmpClient = null;
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.mmpClient;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    delete runtimeOverrides.apiKey;
    vi.unstubAllEnvs();
  });

  it("等待输入卸载上下文，单个驻留名额仍能推进其他对话并恢复原任务", async () => {
    const { admissionLimits } = await import("@/lib/agent/runtime/admission");
    const { resolveQuestion } = await import("@/lib/agent/runtime/questions");
    const oldLimit = admissionLimits.context;
    admissionLimits.context = 1;
    const firstKey=createNewSessionKey(userId), secondKey=createNewSessionKey(userId);
    sessions.push(firstKey,secondKey);
    const { streamFn,seen } = scripted([
      { calls:[{ type:"toolCall",id:"park-input",name:exposedName("ask_user"),arguments:{ questions:[{questionId:"q",header:"日期",question:"选哪天？",options:[{label:"周一"},{label:"周二"}]}] } }] },
      { text:"第二个对话完成" }, { text:"原任务收到周一" }, {text:"追加要求已处理"},
    ]);
    runtimeOverrides.streamFn=streamFn;
    try {
      const first=await startRun({sessionId:firstKey,userId,message:"先问我日期"});
      let questionId:string|undefined;
      for (let i=0;i<200;i++) {
        questionId=(await getPool().query("SELECT id FROM agent_question WHERE run_id=$1", [first.runId])).rows[0]?.id;
        const resident=(await getPool().query("SELECT 1 FROM agent_admission WHERE run_id=$1 AND resource='context' AND state='active'", [first.runId])).rowCount;
        if (questionId && !resident) break;
        await new Promise((r)=>setTimeout(r,20));
      }
      expect(questionId).toBeDefined();
      const second=await startRun({sessionId:secondKey,userId,message:"完成另一项工作"});
      expect(second.status).toBe("queued");
      expect((await collectUntilTerminal(secondKey)).some((l)=>l.type==="final" && l.text.includes("第二个对话完成"))).toBe(true);
      await waitForIdle(secondKey);
      expect((await getPool().query("SELECT status FROM agent_run WHERE id=$1", [first.runId])).rows[0].status).toBe("awaiting_answer");
      expect(await steerRun(firstKey,"追加要求：安排上午")).toMatchObject({runId:first.runId});
      await resolveQuestion(questionId!,{answers:{q:["周一"]}});
      const resumed=await collectUntilTerminal(firstKey);
      expect(resumed.some((l)=>l.type==="final" && l.text.includes("追加要求"))).toBe(true);
      await waitForIdle(firstKey);
      expect(seen).toHaveLength(4);
      expect(JSON.stringify(seen[2].messages)).toContain("用户的回答");
      expect(await getHistory(firstKey)).toContainEqual({role:"assistant",content:"原任务收到周一"});
      expect(JSON.stringify(seen[3].messages)).toContain("追加要求：安排上午");
    } finally {
      await abortRun(firstKey); await abortRun(secondKey);
      admissionLimits.context=oldLimit;
    }
  });

  it("模型调 ask_user → question 行（QuestionInfo 形态）→ 用户回答 → 模型看到答案；取消 → 错误结果", async () => {
    const { questionSession, resolveQuestion, listPendingQuestions } = await import("@/lib/agent/runtime/questions");
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

  it("非阻塞提问立即继续独立工作；迟到回答按 questionId 只入 inbox 一次并启动后续执行", async () => {
    const { resolveQuestion,listQuestions } = await import("@/lib/agent/runtime/questions");
    const deferred: ToolCall = {
      type: "toolCall",id: "c_deferred",name: exposedName("ask_user"),arguments: {
        mode: "continue_independent",
        continueWith: "核对枪声次数、人物动作和已有素材",
        blockedUntilAnswer: "确定最终音色并写入 cue",
        questions: [{ questionId: "style",header: "枪声风格",question: "这一枪希望写实还是舞台化？",
          options: [{ label: "写实" },{ label: "舞台化" }] }],
      },
    };
    const { streamFn,seen } = scripted([
      { calls: [deferred] },
      { text: "独立核对已完成，音色仍等待你的选择。" },
      { text: "已按迟到回答继续未完成部分。" },
    ]);
    runtimeOverrides.streamFn=streamFn;
    const key=createNewSessionKey(userId);
    sessions.push(key);
    await startRun({sessionId:key,userId,message:"整理第三幕枪声"});
    await collectUntilTerminal(key);
    await waitForIdle(key);

    const [question] = await listQuestions(key);
    expect(question).toMatchObject({
      toolCallId: "c_deferred",waitMode: "continue_independent",status: "pending",
      continuation: { continueWith: "核对枪声次数、人物动作和已有素材",blockedUntilAnswer: "确定最终音色并写入 cue" },
    });
    expect(question.expiresAtMs).toBeUndefined();
    expect((await listSessions(userId)).find((session)=>session.key===key)).toMatchObject({pendingQuestionCount:1});
    expect((await getPool().query("SELECT status FROM agent_run WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1",[key])).rows[0].status).toBe("completed");
    expect(JSON.stringify(seen[1].messages)).toContain("pending 不代表默认选择、跳过或同意");
    expect(JSON.stringify(seen[1].messages)).toContain("只可继续：核对枪声次数、人物动作和已有素材");

    const results=await Promise.all([
      resolveQuestion(question.id,{answers:{style:["舞台化"]}}),
      resolveQuestion(question.id,{answers:{style:["写实"]}}),
    ]);
    expect(results.sort()).toEqual([false,true]);
    const inbox = await getPool().query<{ message: string; payload: { questionAnswer: { questionId: string } } }>(
      "SELECT message,payload FROM agent_session_inbox WHERE session_id=$1",[key],
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].payload.questionAnswer.questionId).toBe(question.id);
    expect(inbox.rows[0].message).toContain(`问题 id：${question.id}`);
    expect(inbox.rows[0].message).toContain("不要自动撤销已经落地的业务写入");

    const cursor=(await readEventsSince(key,0)).at(-1)?.seq ?? 0;
    await (await import("@/lib/agent/runtime/service")).dispatchPendingSession(key);
    await collectUntilTerminal(key,10_000,cursor);
    await waitForIdle(key);
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(seen[2].messages)).toContain(`<clickin-question-answer>`);
    expect(JSON.stringify(seen[2].messages)).toContain(`问题 id：${question.id}`);
    expect((await getPool().query("SELECT count(*)::int AS n FROM agent_session_inbox WHERE session_id=$1",[key])).rows[0].n).toBe(0);
  });

  it("回答已到但 deferred 工具结果尚未落库时崩溃，恢复只消费答案一次", async () => {
    const { PgSessionStorage }=await import("@/lib/agent/runtime/pg-session-storage");
    const { Session }=await import("../../vendor/openclaw/packages/agent-core/src/harness/session/session");
    const { newRunId }=await import("@/lib/agent/runtime/ids");
    const { createOrReuseQuestion,resolveQuestion }=await import("@/lib/agent/runtime/questions");
    const key=createNewSessionKey(userId);
    sessions.push(key);
    const storage=await PgSessionStorage.create({id:key,userId,productionId:null});
    const session=new Session(storage);
    const runId=newRunId();
    const call: ToolCall={type:"toolCall",id:"c_deferred_recovery",name:exposedName("ask_user"),arguments:{
      mode:"continue_independent",continueWith:"核对动作",blockedUntilAnswer:"确定音色",
      questions:[{questionId:"style",header:"风格",question:"写实还是舞台化？",options:[{label:"写实"},{label:"舞台化"}]}],
    }};
    await session.appendMessage({role:"user",content:[{type:"text",text:"整理枪声"}],timestamp:Date.now()});
    await session.appendMessage({...base(),content:[call],stopReason:"toolUse"});
    await getPool().query(
      `INSERT INTO agent_run(id,session_id,status,owner,heartbeat_at,model)
       VALUES($1,$2,'running','dead:1',now()-interval '5 minutes',$3)`,[runId,key,CHAT_MODEL.id],
    );
    const question=await createOrReuseQuestion({
      runId,sessionId:key,toolCallId:call.id,waitMode:"continue_independent",
      continuation:{continueWith:"核对动作",blockedUntilAnswer:"确定音色"},
      questions:call.arguments.questions as never,
    });
    expect(await resolveQuestion(question.id,{answers:{style:["舞台化"]}})).toBe(true);
    expect((await getPool().query("SELECT count(*)::int AS n FROM agent_session_inbox WHERE session_id=$1",[key])).rows[0].n).toBe(1);

    const { streamFn,seen }=scripted([{text:"已按舞台化继续未完成部分"}]);
    runtimeOverrides.streamFn=streamFn;
    expect(await resumeOrphans(key)).toBe(1);
    await collectUntilTerminal(key);
    await waitForIdle(key);
    expect(JSON.stringify(seen[0].messages)).toContain("用户的回答");
    expect(JSON.stringify(seen[0].messages)).not.toContain("<clickin-question-answer>");
    expect((await getPool().query("SELECT count(*)::int AS n FROM agent_session_inbox WHERE session_id=$1",[key])).rows[0].n).toBe(0);
  });

  it("同轮多个待补充问题与新指令交错时，各自按持久 id 排队", async () => {
    runtimeOverrides.streamFn=scripted([{ text:"先建立会话" }]).streamFn;
    const key=createNewSessionKey(userId);
    sessions.push(key);
    const started=await startRun({sessionId:key,userId,message:"开始整理"});
    await collectUntilTerminal(key);
    await waitForIdle(key);
    const { createOrReuseQuestion,resolveQuestion } = await import("@/lib/agent/runtime/questions");
    const { enqueueSessionInput,pendingInputsForSession } = await import("@/lib/agent/runtime/session-inbox");
    const makeQuestion=(toolCallId:string,questionId:string)=>createOrReuseQuestion({
      runId:started.runId,sessionId:key,toolCallId,waitMode:"continue_independent",
      continuation:{continueWith:`继续 ${questionId}`,blockedUntilAnswer:`等待 ${questionId}`},
      questions:[{questionId,header:questionId,question:`问题 ${questionId}？`,options:[{label:"甲"},{label:"乙"}]}],
    });
    const [first,second]=await Promise.all([makeQuestion("call_first","q_first"),makeQuestion("call_second","q_second")]);

    expect(await resolveQuestion(second.id,{answers:{q_second:["乙"]}})).toBe(true);
    await enqueueSessionInput({sessionId:key,runId:null,message:"用户追加的新指令",attachmentIds:[]});
    expect(await resolveQuestion(first.id,{answers:{q_first:["甲"]}})).toBe(true);

    const queued=await pendingInputsForSession(key);
    expect(queued).toHaveLength(3);
    expect(queued[0].message).toContain(`问题 id：${second.id}`);
    expect(queued[1].message).toBe("用户追加的新指令");
    expect(queued[2].message).toContain(`问题 id：${first.id}`);
    expect(queued[0].message).not.toContain(first.id);
    expect(queued[2].message).not.toContain(second.id);
  });
});

describe("§4.4 排水/脱离：等待态 run 交给下一个进程，不留痕、不重问", () => {
  let userId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-detach-${shortId()}`, null, false));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("EMBEDDING_API_KEY", "test-key");
    runtimeOverrides.apiKey = "test-key";
    runtimeOverrides.mmpClient = null;
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.mmpClient;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    delete runtimeOverrides.apiKey;
    vi.unstubAllEnvs();
  });

  it("等提问时脱离 → transcript 无 aborted、run 仍 awaiting_answer、无 aborted 事件；接管后复用同一问题并续跑", async () => {
    const { detachAll, resumeOrphans } = await import("@/lib/agent/runtime/service");
    const { resolveQuestion } = await import("@/lib/agent/runtime/questions");
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
    const { detachAll, resumeOrphans } = await import("@/lib/agent/runtime/service");
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
  let versionId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `runtime-deferred-${shortId()}`, null, false));
    ({ prodId, versionId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("EMBEDDING_API_KEY", "test-key");
    runtimeOverrides.apiKey = "test-key";
    runtimeOverrides.mmpClient = null;
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.mmpClient;
    for (const id of sessions) await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [id]).catch(() => {});
    delete runtimeOverrides.apiKey;
    vi.unstubAllEnvs();
    await cleanupProduction(prodId).catch(() => {});
  });

  it.each([
    ["production.script_search", { query: "划桨" }, "production.script"],
    ["production.script_read_section", { sectionId: "missing-section" }, "production.script"],
    ["production.script_read_page", { page: 1 }, "production.script"],
    ["production.scene_read", { sceneId: "missing-scene" }, "production.dramaturgy"],
    ["production.scene_list", {}, "production.dramaturgy"],
    ["production.character_list", {}, "production.dramaturgy"],
  ] as const)("#1019 调用 %s 后同轮展开整族，下一轮按近期使用恢复", async (name, args, family) => {
    const call: ToolCall = { type: "toolCall", id: `c_family_${name}`, name: exposedName(name), arguments: args };
    const { streamFn, seen } = scripted([{ calls: [call] }, { text: "已核对" },
      ...Array.from({ length: 4 }, () => ({ text: "接着讨论" }))]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(userId, prodId);
    sessions.push(key);
    await startRun({ sessionId: key, userId, message: "你好呀", pageKey: "prod:home" });
    await collectUntilTerminal(key);
    await waitForIdle(key);
    const members = TOOL_CATALOG.filter(e => e.family === family).map(e => exposedName(e.name));
    const otherWrite = exposedName(family === "production.script" ? "production.scene_propose_update" : "production.script_propose_rewrite");
    if (["production.script_read_page", "production.scene_read"].includes(name)) {
      expect(seen[0].tools).not.toContain(exposedName(name));
    } else {
      expect(seen[0].tools).toContain(exposedName(name));
    }
    expect(seen[0].tools).not.toContain(exposedName("production.script_read_window"));
    expect(seen[0].tools).not.toContain(exposedName("production.scene_read"));
    for (const member of members) expect(seen[1].tools).toContain(member);
    expect(seen[1].tools).not.toContain(otherWrite);
    await startRun({ sessionId: key, userId, message: "你好呀", pageKey: "prod:home" });
    await waitForIdle(key);
    for (const member of members) expect(seen[2].tools).toContain(member);
    expect(seen[2].tools).not.toContain(otherWrite);
    for (let i = 0; i < 3; i++) {
      await startRun({ sessionId: key, userId, message: "你好呀", pageKey: "prod:home" });
      await waitForIdle(key);
    }
    expect(seen[5].tools).not.toContain(exposedName(family === "production.script" ? "production.script_propose_rewrite" : "production.scene_propose_update"));
  });

  it("#1019 入口展开的写工具仍等待审批，拒绝后无写入", async () => {
    const sceneId = await makeScene(prodId, versionId);
    const read: ToolCall = { type: "toolCall", id: "c_family_read", name: exposedName("production.script_search"), arguments: { query: "划桨" } };
    const write: ToolCall = { type: "toolCall", id: "c_family_write", name: exposedName("production.script_propose_edit_blocks"),
      arguments: { inserts: [{ afterBlockId: sceneId, type: "dialogue", content: "只多划一桨" }], summary: "增加台词" } };
    const { streamFn, seen } = scripted([{ calls: [read] }, { calls: [write] }, { text: "保持原样" }]);
    runtimeOverrides.streamFn = streamFn;
    const key = createNewSessionKey(userId, prodId);
    sessions.push(key);
    await startRun({ sessionId: key, userId, message: "你好呀", pageKey: "prod:home" });
    let approval: Extract<StreamLine, { type: "approval" }> | undefined;
    try {
      for (let i = 0; i < 200 && !approval; i++) {
        approval = (await readEventsSince(key, 0)).map(row => row.line)
          .find((line): line is Extract<StreamLine, { type: "approval" }> => line.type === "approval");
        if (!approval) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(seen[1].tools).toContain(write.name);
      expect(approval?.approval?.toolCallId).toBe(write.id);
      await resolveApproval(approval!.approval!.id, "deny", userId, "先保留原文");
      const lines = await collectUntilTerminal(key);
      await waitForIdle(key);
      expect(lines.some(line => line.type === "mutation")).toBe(false);
      expect(JSON.stringify(seen[2].messages)).toContain("先保留原文");
    } finally {
      await abortRun(key);
    }
  });

  it("首页闲聊（wiki 族不在工具面）→ 模型调 find_tools → 再按名调 wiki_tree（不在列表里也能解析执行）", async () => {
    const find: ToolCall = { type: "toolCall", id: "c_find", name: exposedName("find_tools"), arguments: { query: "看看有哪些文档" } };
    const tree: ToolCall = { type: "toolCall", id: "c_tree", name: exposedName("production.wiki_tree"), arguments: {} };
    const search: ToolCall = { type: "toolCall", id: "c_after_deferred", name: exposedName("production.script_search"), arguments: { query: "划桨" } };
    const { streamFn, seen } = scripted([{ calls: [find] }, { calls: [tree] }, { calls: [search] }, { text: "文档列在上面了" }]);
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
    expect(seen[3].tools).toContain(exposedName("production.wiki_tree")); // 展开另一族不能丢失已延迟加载的工具
    expect(seen[3].tools).toContain(exposedName("production.script_propose_rewrite"));
  });
});
