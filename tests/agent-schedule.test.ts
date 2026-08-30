import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, StreamFn, ToolCall } from "../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/db";
import { createWiki, getWiki } from "@/lib/wiki-db";
import { makeProduction, cleanupProduction, setProductionTier, shortId } from "./factories";
import { startRun, waitForIdle, runtimeOverrides } from "@/lib/agent-runtime/service";
import { readEventsSince } from "@/lib/agent-runtime/events";
import { CHAT_MODEL } from "@/lib/agent-runtime/config";
import { buildTools, exposedName, UNATTENDED_ALLOWED_TOOLS, type RunHandle } from "@/lib/agent-runtime/tools";
import { createSchedule, getSchedule, tickSchedules, listSchedules, setScheduleStatus, buildScheduledMessage } from "@/lib/agent-runtime/schedules";
import { approvalCard } from "@/lib/agent-runtime/cards";

// AI 定时任务（db/add-agent-schedule.sql, lib/agent-runtime/schedules.ts）端到端：
// 建任务（工具 + 确认卡 + 审计）→ 节拍认领 → 以创建者身份开新会话跑 run（无人值守门）→
// 收尾通知（附改动清单）→ 推进时间表；前置门把任务转 paused；finish done 结束任务。

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = () => ({ role: "assistant" as const, api: CHAT_MODEL.api, provider: CHAT_MODEL.provider, model: CHAT_MODEL.id, usage: USAGE, timestamp: Date.now() });
type Step = { text: string } | { calls: ToolCall[] };
function scripted(script: Step[]) {
  const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
  const streamFn: StreamFn = (_model, context) => {
    seen.push({ messages: context.messages, tools: (context.tools ?? []).map((t) => t.name) });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    const stream = createAssistantMessageEventStream();
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
const lastToolResult = (s: { messages: unknown[] }) => s.messages[s.messages.length - 1] as { role: string; isError: boolean; content: Array<{ text?: string }> };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name: exposedName(name), arguments: args });

async function sessionOfSchedule(scheduleId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const r = await getPool().query<{ id: string }>(`SELECT id FROM agent_session WHERE schedule_id = $1 ORDER BY created_at DESC LIMIT 1`, [scheduleId]);
    if (r.rows[0]) return r.rows[0].id;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("scheduled session not created");
}
async function waitTerminal(sessionId: string) {
  for (let i = 0; i < 400; i++) {
    const lines = (await readEventsSince(sessionId, 0)).map((r) => r.line);
    if (lines.some((l) => l.type === "final" || l.type === "aborted" || l.type === "error")) { await waitForIdle(sessionId); return lines; }
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("no terminal event");
}
async function makeDue(scheduleId: string) {
  await getPool().query(`UPDATE agent_schedule SET next_fire_at = now() - interval '1 minute' WHERE id = $1`, [scheduleId]);
}
async function notificationsFor(scheduleId: string) {
  const r = await getPool().query<{ title: string; body: string; view_href: string | null; category: string; kind: string }>(
    `SELECT title, body, view_href, category, kind FROM user_notification WHERE entity_type = 'agent_schedule' AND entity_id = $1 ORDER BY created_at`, [scheduleId]);
  return r.rows;
}

describe("定时任务", () => {
  let userId: string;
  let prodId: string;
  const scheduleIds: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `sched-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro");
    runtimeOverrides.apiKey = "test-key";
  });
  afterAll(async () => {
    delete runtimeOverrides.streamFn;
    delete runtimeOverrides.apiKey;
    await getPool().query(`DELETE FROM agent_schedule WHERE user_id = $1`, [userId]).catch(() => {});
    await getPool().query(`DELETE FROM agent_session WHERE user_id = $1`, [userId]).catch(() => {});
    await getPool().query(`DELETE FROM user_notification WHERE user_id = $1`, [userId]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  it("注册表：只有 wiki 新建/更新可无人值守；删除类永不", () => {
    expect([...UNATTENDED_ALLOWED_TOOLS].sort()).toEqual(["production.wiki_propose_create", "production.wiki_propose_update"]);
  });

  it("创建：校验（个人任务不能授权制作工具 / 太勤 / 容量）；经工具创建过审计（scope schedule）；确认卡写清时间表与写授权", async () => {
    const bad = await createSchedule({ userId, productionId: null, name: "x", prompt: "y", schedule: { kind: "every", everyMs: 3_600_000 }, allowedTools: ["production.wiki_propose_update"] });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("个人任务") });
    const tooOften = await createSchedule({ userId, productionId: null, name: "x", prompt: "y", schedule: { kind: "cron", expr: "*/10 * * * *" } });
    expect(tooOften).toMatchObject({ ok: false, error: expect.stringContaining("超过上限") });
    const notAllowed = await createSchedule({ userId, productionId: prodId, name: "x", prompt: "y", schedule: { kind: "every", everyMs: 3_600_000 }, allowedTools: ["production.wiki_propose_delete"] });
    expect(notAllowed).toMatchObject({ ok: false, error: expect.stringContaining("不允许无人值守") });

    // 经工具创建（个人会话）：审计落 created 行
    const run = { runId: "ar_x", sessionId: "s_x", signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false, pageKey: "my:milestones" } as RunHandle;
    const tool = buildTools({ userId, productionId: null, run }).find((t) => t.name === exposedName("my.schedule_propose"))!;
    const callId = `c_${shortId()}`;
    const out = await tool.execute(callId, { action: "create", name: "每日提醒", prompt: "提醒我看里程碑", schedule: { kind: "cron", expr: "0 9 * * *" }, summary: "用户要求" }, run.signal);
    expect((out.content[0] as { text: string }).text).toContain("已创建定时任务");
    const mine = await listSchedules(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "每日提醒", status: "active", pageKey: "my:milestones", allowedTools: [] });
    scheduleIds.push(mine[0].id);
    const audit = await getPool().query<{ scope: string; action: string; label: string; entity_id: string }>(`SELECT scope, action, label, entity_id FROM agent_mutation WHERE user_id = $1 AND tool_call_id = $2`, [userId, callId]);
    expect(audit.rows[0]).toEqual({ scope: "schedule", action: "created", label: "每日提醒", entity_id: mine[0].id });

    // 容量：free 档 3 条
    for (let i = 0; i < 2; i++) {
      const r = await createSchedule({ userId, productionId: null, name: `n${i}`, prompt: "p", schedule: { kind: "every", everyMs: 3_600_000 } });
      expect(r.ok).toBe(true);
      if (r.ok) scheduleIds.push(r.row.id);
    }
    const full = await createSchedule({ userId, productionId: null, name: "n3", prompt: "p", schedule: { kind: "every", everyMs: 3_600_000 } });
    expect(full).toMatchObject({ ok: false, error: expect.stringContaining("上限") });
    // 暂停一条腾出容量
    expect((await setScheduleStatus(scheduleIds[1], userId, "paused")).ok).toBe(true);
    expect((await createSchedule({ userId, productionId: null, name: "n3", prompt: "p", schedule: { kind: "every", everyMs: 3_600_000 } })).ok).toBe(true);
    await getPool().query(`DELETE FROM agent_schedule WHERE user_id = $1`, [userId]);

    const card = approvalCard("my-schedule_propose", { action: "create", name: "整理灵感库", prompt: "把子文档大纲并进主文档", schedule: { kind: "cron", expr: "0 23 * * *" }, allowedTools: ["production.wiki_propose_update"], summary: "用户要求" });
    expect(card.title).toBe("创建定时任务：整理灵感库");
    expect(card.description).toContain("cron 0 23 * * *（Asia/Shanghai）");
    expect(card.description).toContain("允许直接执行");
    expect(card.description).toContain("提议修改文档");
  });

  it("触发：认领 → 新会话 → 无人值守门（授权的写直接生效并进账本；ask_user / 未授权写被 block）→ 汇报 → 通知附改动清单 → 推进", async () => {
    const doc = await createWiki({ productionId: prodId, title: "灵感库", body: "第一条\n", createdBy: userId });
    const created = await createSchedule({
      userId, productionId: prodId, name: "整理灵感库", prompt: `把新灵感并进《灵感库》（id ${doc.id}）`,
      schedule: { kind: "cron", expr: "0 23 * * *" }, allowedTools: ["production.wiki_propose_update"], pageKey: "prod:wiki",
    });
    if (!created.ok) throw new Error(created.error);
    const sched = created.row;
    const { streamFn, seen } = scripted([
      { calls: [call("c_upd", "production.wiki_propose_update", { wikiId: doc.id, body: "第一条\n第二条\n", summary: "并入" })] },
      { calls: [call("c_ask", "ask_user", { questions: [{ questionId: "q1", header: "问", question: "要不要？", options: [{ label: "要" }] }] })] },
      { calls: [call("c_del", "production.wiki_propose_delete", { wikiId: doc.id, summary: "删" })] },
      { calls: [call("c_fin", "schedule.finish", { summary: "已把第二条并入主文档；另有一篇建议删除，需你确认。", notify: true })] },
      { text: "整理完成" },
    ]);
    runtimeOverrides.streamFn = streamFn;

    // 未到点不认领
    expect(await tickSchedules(startRun)).toBe(0);
    await makeDue(sched.id);
    expect(await tickSchedules(startRun)).toBe(1);
    const sessionId = await sessionOfSchedule(sched.id);
    const lines = await waitTerminal(sessionId);

    // 会话 / run 都挂回任务；标题带 ⏰
    const sess = await getPool().query<{ title: string; user_id: string; production_id: string }>(`SELECT title, user_id, production_id FROM agent_session WHERE id = $1`, [sessionId]);
    expect(sess.rows[0]).toMatchObject({ user_id: userId, production_id: prodId });
    expect(sess.rows[0].title.startsWith("⏰ 整理灵感库")).toBe(true);
    const run = await getPool().query<{ id: string; schedule_id: string; status: string; page_key: string }>(`SELECT id, schedule_id, status, page_key FROM agent_run WHERE session_id = $1`, [sessionId]);
    expect(run.rows[0]).toMatchObject({ schedule_id: sched.id, status: "completed", page_key: "prod:wiki" });

    // 首轮：最后一条用户消息是任务指令 + 须知（前面可能有临时插入的召回块）；工具面带汇报工具与授权的写工具
    const users = seen[0].messages.filter((m) => (m as { role: string }).role === "user") as Array<{ content: Array<{ text?: string }> }>;
    const msg = users[users.length - 1].content.map((c) => c.text ?? "").join("");
    expect(msg).toContain("定时任务《整理灵感库》自动运行 · 第 1 次");
    expect(msg).toContain("提议修改文档");
    expect(msg).toContain("clickin__schedule-finish");
    expect(seen[0].tools).toContain(exposedName("schedule.finish"));
    expect(seen[0].tools).toContain(exposedName("production.wiki_propose_update"));

    // 授权的写：没有审批卡，直接生效
    expect(lines.some((l) => l.type === "approval")).toBe(false);
    expect((await getWiki(doc.id, prodId))!.body).toBe("第一条\n第二条\n");
    expect(lastToolResult(seen[1]).isError).toBe(false);
    // ask_user / 未授权写：block 回模型
    expect(lastToolResult(seen[2]).isError).toBe(true);
    expect(lastToolResult(seen[2]).content[0]?.text).toContain("无人值守");
    expect(lastToolResult(seen[3]).isError).toBe(true);
    expect(lastToolResult(seen[3]).content[0]?.text).toContain("未获授权");
    expect(await getWiki(doc.id, prodId)).not.toBeNull();
    expect(lastToolResult(seen[4]).content[0]?.text).toContain("已记录汇报");

    // 账本：unattended + schedule_id；mutation 行带摘要
    const audit = await getPool().query<{ unattended: boolean; schedule_id: string; action: string }>(`SELECT unattended, schedule_id, action FROM agent_mutation WHERE run_id = $1`, [run.rows[0].id]);
    expect(audit.rows).toEqual([{ unattended: true, schedule_id: sched.id, action: "updated" }]);
    const mutation = lines.find((l) => l.type === "mutation") as { summary?: string };
    expect(mutation?.summary).toContain("更新文档《灵感库》");

    // 任务推进：计数、上次摘要、下一次是明天 23:00（上海）
    const after = (await getSchedule(sched.id))!;
    expect(after.fireCount).toBe(1);
    expect(after.status).toBe("active");
    expect(after.lastRunId).toBe(run.rows[0].id);
    expect(after.lastSummary).toBe("已把第二条并入主文档；另有一篇建议删除，需你确认。");
    expect(after.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.nextFireAt!.toISOString().endsWith("T15:00:00.000Z")).toBe(true);
    expect(buildScheduledMessage(after, new Date())).toContain("上次运行的结果摘要：已把第二条");

    // 通知只投创建者：摘要 + 改动清单 + 深链
    const notes = await notificationsFor(sched.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "agent_schedule", title: "⏰ 整理灵感库", category: "info" });
    expect(notes[0].body).toContain("已把第二条并入主文档");
    expect(notes[0].body).toContain("更新文档《灵感库》：正文 +");
    expect(notes[0].view_href).toContain(`/production/${prodId}?agentSession=${encodeURIComponent(sessionId)}`);
    scheduleIds.push(sched.id);
  });

  it("汇报 done + notify=false 且无写 → 任务结束、不通知；overlap（上次还在跑）→ 跳过本次但照常推进", async () => {
    const created = await createSchedule({ userId, productionId: null, name: "盯一下", prompt: "看看有没有新里程碑", schedule: { kind: "every", everyMs: 3_600_000 } });
    if (!created.ok) throw new Error(created.error);
    const sched = created.row;
    runtimeOverrides.streamFn = scripted([
      { calls: [call("c_fin2", "schedule.finish", { summary: "没有新东西", notify: false, done: true })] },
      { text: "无事" },
    ]).streamFn;
    await makeDue(sched.id);
    expect(await tickSchedules(startRun)).toBe(1);
    const sessionId = await sessionOfSchedule(sched.id);
    await waitTerminal(sessionId);
    const after = (await getSchedule(sched.id))!;
    expect(after.status).toBe("done");
    expect(await notificationsFor(sched.id)).toHaveLength(0);

    // overlap：造一条"还在跑"的 run 挂成 last_run_id，再到点 → 不开新会话
    const c2 = await createSchedule({ userId, productionId: null, name: "重叠", prompt: "p", schedule: { kind: "every", everyMs: 3_600_000 } });
    if (!c2.ok) throw new Error(c2.error);
    const s2 = c2.row;
    const { createNewSessionKey } = await import("@/lib/agent-tools/session-identity");
    const { PgSessionStorage } = await import("@/lib/agent-runtime/pg-session-storage");
    const busyKey = createNewSessionKey(userId);
    await PgSessionStorage.create({ id: busyKey, userId, productionId: null });
    const busyRun = `ar_busy_${shortId()}`;
    await getPool().query(`INSERT INTO agent_run (id, session_id, status, owner, heartbeat_at) VALUES ($1, $2, 'running', 'x:1', now())`, [busyRun, busyKey]);
    await getPool().query(`UPDATE agent_schedule SET last_run_id = $2, next_fire_at = now() - interval '1 minute' WHERE id = $1`, [s2.id, busyRun]);
    expect(await tickSchedules(startRun)).toBe(0);
    const s2after = (await getSchedule(s2.id))!;
    expect(s2after.fireCount).toBe(1);
    expect(s2after.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await getPool().query(`SELECT 1 FROM agent_session WHERE schedule_id = $1`, [s2.id])).rowCount).toBe(0);
    await getPool().query(`UPDATE agent_run SET status = 'completed' WHERE id = $1`, [busyRun]);
  });

  it("前置门：制作档位没开 AI → 任务转 paused（带原因）并通知，不开会话", async () => {
    const created = await createSchedule({ userId, productionId: prodId, name: "档位门", prompt: "p", schedule: { kind: "every", everyMs: 3_600_000 } });
    if (!created.ok) throw new Error(created.error);
    const sched = created.row;
    await setProductionTier(prodId, "free");
    try {
      await makeDue(sched.id);
      expect(await tickSchedules(startRun)).toBe(0);
      const after = (await getSchedule(sched.id))!;
      expect(after.status).toBe("paused");
      expect(after.pausedReason).toContain("档位");
      const notes = await notificationsFor(sched.id);
      expect(notes[0]).toMatchObject({ category: "warning" });
      expect(notes[0].title).toContain("已暂停");
      expect((await getPool().query(`SELECT 1 FROM agent_session WHERE schedule_id = $1`, [sched.id])).rowCount).toBe(0);
      // 人工恢复要重算下一次
      const resumed = await setScheduleStatus(sched.id, userId, "active");
      expect(resumed.ok && resumed.row.nextFireAt!.getTime() > Date.now()).toBe(true);
    } finally {
      await setProductionTier(prodId, "pro");
    }
  });
});
