// AI 定时任务（db/add-agent-schedule.sql）：CRUD、节拍认领、触发、收尾通知。
//
// 定谳（2026-08-30）：
// - 不是真 cron：runner 的 60s 节拍用租约式原子 UPDATE 认领到期行，到点以创建者身份
//   **开一个新会话**跑一次 run，结果经站内通知只投给创建者（不投群——跨受众要有人）。
// - 权限实时查、不快照：触发出的 run 与普通会话同构；触发前只做三道前置门（成员 active /
//   制作档位有 AI / 账号在），终局性失败置 paused + 通知，暂时性（额度用尽）跳过本次。
// - 无人值守写**允许**：边界 = 注册表 Def.unattended（缺省 deny）∩ 本行 allowed_tools（创建时
//   人在确认卡上圈定）；每次写进 agent_mutation 账本，通知里列改动——先做后审。
// - 任务内的 schedule 工具只能汇报/停自己（schedule.finish），不能建新任务（防自繁殖）。
// - overlap = skip；停机漏掉的触发只补一次；成本闸常量在 lib/plan.ts（SCHEDULE_LIMITS）。

import { getPool } from "@/lib/pg";
import { SERVER_URL } from "@/lib/server-url";
import { getUserTier, maxActiveSchedulesForTier, productionFeatureAllowed } from "@/lib/plan";
import { createNewSessionKey } from "@/lib/agent-tools/session-identity";
import { neutralizeInjectionTags } from "@/lib/agent-injection-safety";
import { toolLabel } from "@/lib/agent-tool-labels";
import { newScheduleId } from "./ids";
import { RUNNER_OWNER } from "./config";
import { validateSchedule, nextFireAt, describeSchedule, formatInTz, type Schedule } from "./schedule-cron";
import { describeMutation, listRunMutations, type MutationRecord } from "./mutation-audit";

export const SCHEDULE_TICK_MS = Number(process.env.AGENT_SCHEDULE_TICK_MS ?? 60_000);
const LEASE_MS = 5 * 60_000;
const NAME_MAX = 80;
const PROMPT_MAX = 4000;
const SUMMARY_MAX = 1000;
/** 触发出的会话多久后自动归档（列表里不再显示；历史/审计仍在） */
const AUTO_ARCHIVE_DAYS = 7;

export type ScheduleStatus = "active" | "paused" | "done";

export interface ScheduleRow {
  id: string;
  userId: string;
  productionId: string | null;
  name: string;
  prompt: string;
  schedule: Schedule;
  allowedTools: string[];
  pageKey: string | null;
  status: ScheduleStatus;
  pausedReason: string | null;
  nextFireAt: Date | null;
  lastFiredAt: Date | null;
  lastRunId: string | null;
  lastSummary: string | null;
  fireCount: number;
  maxFires: number | null;
  expiresAt: Date | null;
  createdAt: Date;
}

type Raw = {
  id: string; user_id: string; production_id: string | null; name: string; prompt: string; schedule: Schedule; allowed_tools: string[];
  page_key: string | null; status: ScheduleStatus; paused_reason: string | null; next_fire_at: Date | null; last_fired_at: Date | null;
  last_run_id: string | null; last_summary: string | null; fire_count: number; max_fires: number | null; expires_at: Date | null; created_at: Date;
};
const COLS = `id, user_id, production_id, name, prompt, schedule, allowed_tools, page_key, status, paused_reason, next_fire_at, last_fired_at, last_run_id, last_summary, fire_count, max_fires, expires_at, created_at`;
function toRow(r: Raw): ScheduleRow {
  return {
    id: r.id, userId: r.user_id, productionId: r.production_id, name: r.name, prompt: r.prompt, schedule: r.schedule, allowedTools: r.allowed_tools ?? [],
    pageKey: r.page_key, status: r.status, pausedReason: r.paused_reason, nextFireAt: r.next_fire_at, lastFiredAt: r.last_fired_at, lastRunId: r.last_run_id,
    lastSummary: r.last_summary, fireCount: r.fire_count, maxFires: r.max_fires, expiresAt: r.expires_at, createdAt: r.created_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export type ScheduleResult = { ok: true; row: ScheduleRow } | { ok: false; error: string };

export interface CreateScheduleInput {
  userId: string;
  productionId: string | null;
  name: string;
  prompt: string;
  schedule: unknown;
  allowedTools?: string[];
  pageKey?: string | null;
  maxFires?: number | null;
  createdBySessionId?: string | null;
}

/** 允许无人值守写的工具全集（注册表 unattended=allow）——由 tools.ts 注入，避免循环 import。 */
let unattendedAllowed: ReadonlySet<string> = new Set();
export function registerUnattendedAllowed(set: ReadonlySet<string>): void { unattendedAllowed = set; }
export function unattendedAllowedTools(): ReadonlySet<string> { return unattendedAllowed; }

function checkAllowedTools(tools: string[] | undefined, productionId: string | null): string | null {
  for (const t of tools ?? []) {
    if (!unattendedAllowed.has(t)) return `工具 ${t} 不允许无人值守执行（只有 ${[...unattendedAllowed].join("、") || "（无）"} 可以）`;
    if (t.startsWith("production.") && !productionId) return `个人任务不能授权制作工具 ${t}（请在关联制作的对话里创建）`;
  }
  return null;
}

async function activeCount(userId: string, excludeId?: string): Promise<number> {
  const r = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_schedule WHERE user_id = $1 AND status = 'active' AND ($2::text IS NULL OR id <> $2)`, [userId, excludeId ?? null],
  );
  return Number(r.rows[0].n);
}

async function assertCapacity(userId: string, excludeId?: string): Promise<string | null> {
  const max = maxActiveSchedulesForTier(await getUserTier(userId));
  if ((await activeCount(userId, excludeId)) >= max) return `活跃定时任务已达上限（${max} 条），请先暂停或删除一条`;
  return null;
}

export async function createSchedule(input: CreateScheduleInput): Promise<ScheduleResult> {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name) return { ok: false, error: "name 不能为空" };
  if (name.length > NAME_MAX) return { ok: false, error: `name 不能超过 ${NAME_MAX} 字` };
  if (!prompt) return { ok: false, error: "prompt 不能为空" };
  if (prompt.length > PROMPT_MAX) return { ok: false, error: `prompt 不能超过 ${PROMPT_MAX} 字` };
  const v = validateSchedule(input.schedule);
  if (!v.ok) return v;
  const toolsErr = checkAllowedTools(input.allowedTools, input.productionId);
  if (toolsErr) return { ok: false, error: toolsErr };
  if (input.maxFires != null && (!Number.isInteger(input.maxFires) || input.maxFires < 1)) return { ok: false, error: "maxFires 必须是正整数" };
  const cap = await assertCapacity(input.userId);
  if (cap) return { ok: false, error: cap };
  const next = nextFireAt(v.schedule, new Date());
  if (!next) return { ok: false, error: "这个时间表不会再触发" };
  const id = newScheduleId();
  const r = await getPool().query<Raw>(
    `INSERT INTO agent_schedule (id, user_id, production_id, name, prompt, schedule, allowed_tools, page_key, next_fire_at, max_fires, created_by_session_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8, $9, $10, (SELECT id FROM agent_session WHERE id = $11)) RETURNING ${COLS}`,
    [id, input.userId, input.productionId, name, prompt, JSON.stringify(v.schedule), [...new Set(input.allowedTools ?? [])], input.pageKey ?? null, next, input.maxFires ?? null, input.createdBySessionId ?? null],
  );
  return { ok: true, row: toRow(r.rows[0]) };
}

export async function getSchedule(id: string): Promise<ScheduleRow | null> {
  const r = await getPool().query<Raw>(`SELECT ${COLS} FROM agent_schedule WHERE id = $1`, [id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** 创建者本人的任务（个人 + 各制作），可选只看某制作。 */
export async function listSchedules(userId: string, opts: { productionId?: string | null } = {}): Promise<ScheduleRow[]> {
  const r = await getPool().query<Raw>(
    `SELECT ${COLS} FROM agent_schedule WHERE user_id = $1 AND ($2::text IS NULL OR production_id = $2)
     ORDER BY (status = 'active') DESC, next_fire_at NULLS LAST, created_at DESC`,
    [userId, opts.productionId ?? null],
  );
  return r.rows.map(toRow);
}

export interface UpdateScheduleInput {
  name?: string; prompt?: string; schedule?: unknown; allowedTools?: string[]; maxFires?: number | null;
}

/** 只有创建者能改自己的任务；改时间表会重算下一次触发。 */
export async function updateSchedule(id: string, userId: string, patch: UpdateScheduleInput): Promise<ScheduleResult> {
  const cur = await getSchedule(id);
  if (!cur || cur.userId !== userId) return { ok: false, error: "没有找到这条定时任务（或它不是你创建的）" };
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id];
  const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > NAME_MAX) return { ok: false, error: `name 不能为空且不超过 ${NAME_MAX} 字` };
    push("name", name);
  }
  if (patch.prompt !== undefined) {
    const prompt = patch.prompt.trim();
    if (!prompt || prompt.length > PROMPT_MAX) return { ok: false, error: `prompt 不能为空且不超过 ${PROMPT_MAX} 字` };
    push("prompt", prompt);
  }
  if (patch.allowedTools !== undefined) {
    const err = checkAllowedTools(patch.allowedTools, cur.productionId);
    if (err) return { ok: false, error: err };
    push("allowed_tools", [...new Set(patch.allowedTools)]);
  }
  if (patch.maxFires !== undefined) {
    if (patch.maxFires != null && (!Number.isInteger(patch.maxFires) || patch.maxFires < 1)) return { ok: false, error: "maxFires 必须是正整数" };
    push("max_fires", patch.maxFires);
  }
  if (patch.schedule !== undefined) {
    const v = validateSchedule(patch.schedule);
    if (!v.ok) return v;
    const next = nextFireAt(v.schedule, new Date());
    if (!next) return { ok: false, error: "这个时间表不会再触发" };
    vals.push(JSON.stringify(v.schedule)); sets.push(`schedule = $${vals.length}::jsonb`);
    if (cur.status === "active") push("next_fire_at", next);
  }
  if (sets.length === 1) return { ok: false, error: "没有提供任何要修改的字段" };
  const r = await getPool().query<Raw>(`UPDATE agent_schedule SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, vals);
  return { ok: true, row: toRow(r.rows[0]) };
}

/** 人工暂停 / 恢复。恢复要过容量闸并重算下一次触发；done 的不能恢复（重建一条）。 */
export async function setScheduleStatus(id: string, userId: string, status: "active" | "paused"): Promise<ScheduleResult> {
  const cur = await getSchedule(id);
  if (!cur || cur.userId !== userId) return { ok: false, error: "没有找到这条定时任务（或它不是你创建的）" };
  if (cur.status === "done") return { ok: false, error: "已结束的任务不能恢复，请新建一条" };
  if (cur.status === status) return { ok: true, row: cur };
  if (status === "active") {
    const cap = await assertCapacity(userId, id);
    if (cap) return { ok: false, error: cap };
    const next = nextFireAt(cur.schedule, new Date());
    if (!next) return { ok: false, error: "这个时间表不会再触发，请修改时间表" };
    const r = await getPool().query<Raw>(
      `UPDATE agent_schedule SET status = 'active', paused_reason = NULL, next_fire_at = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, next],
    );
    return { ok: true, row: toRow(r.rows[0]) };
  }
  const r = await getPool().query<Raw>(
    `UPDATE agent_schedule SET status = 'paused', paused_reason = NULL, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id],
  );
  return { ok: true, row: toRow(r.rows[0]) };
}

export async function deleteSchedule(id: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await getPool().query(`DELETE FROM agent_schedule WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, error: "没有找到这条定时任务（或它不是你创建的）" };
}

// ── 人话 ─────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<ScheduleStatus, string> = { active: "进行中", paused: "已暂停", done: "已结束" };

export function describeScheduleRow(row: ScheduleRow): string {
  const lines = [
    `【${row.name}】(id: ${row.id}) ${STATUS_LABELS[row.status]}${row.pausedReason ? `（${row.pausedReason}）` : ""}`,
    `  时间表：${describeSchedule(row.schedule)}${row.maxFires ? `，共 ${row.maxFires} 次` : ""}`,
    `  范围：${row.productionId ? `制作 ${row.productionId}` : "个人"}${row.allowedTools.length ? `；允许无人值守写：${row.allowedTools.map(toolLabel).join("、")}` : "；只读（不执行写操作）"}`,
    `  指令：${row.prompt.length > 120 ? `${row.prompt.slice(0, 120)}…` : row.prompt}`,
    row.status === "active" && row.nextFireAt ? `  下次：${formatInTz(row.nextFireAt)}` : null,
    row.fireCount > 0 ? `  已运行 ${row.fireCount} 次${row.lastFiredAt ? `，上次 ${formatInTz(row.lastFiredAt)}` : ""}${row.lastSummary ? `：${row.lastSummary.slice(0, 120)}` : ""}` : null,
  ];
  return lines.filter((l): l is string => !!l).join("\n");
}

export function formatScheduleList(rows: ScheduleRow[]): string {
  if (rows.length === 0) return "你还没有定时任务。";
  return rows.map(describeScheduleRow).join("\n\n");
}

// ── 触发 ─────────────────────────────────────────────────────────────────────

export interface ScheduleStartRunInput {
  sessionId: string;
  userId: string;
  message: string;
  pageKey?: string | null;
  scheduleId?: string | null;
}
type StartRunFn = (input: ScheduleStartRunInput) => Promise<{ runId: string }>;

/** 触发出的 run 的用户消息：任务指令 + 无人值守须知。prompt/上次摘要都是可写文本，先净化包裹标签。 */
export function buildScheduledMessage(row: ScheduleRow, now: Date): string {
  const writes = row.allowedTools.length
    ? `允许你直接执行的写操作：${row.allowedTools.map((t) => `${toolLabel(t)}（clickin__${t.replace(/\./g, "-")}）`).join("、")}——它们不需要确认，会直接生效，每次改动都有记录并通知用户。`
    : "本任务没有授权任何写操作：只读。";
  return [
    `【定时任务《${neutralizeInjectionTags(row.name)}》自动运行 · 第 ${row.fireCount + 1} 次 · ${formatInTz(now)}】`,
    "",
    "任务指令：",
    neutralizeInjectionTags(row.prompt),
    "",
    "运行须知（无人值守）：",
    "- 现在没有人在看这个对话。不要提问（ask_user 不可用）；信息不足就按最合理的假设做，并在结果里说明假设。",
    `- ${writes}`,
    "- 其它写操作不会执行：需要的话在结果里写明建议，用户之后会在这个对话里手动处理。",
    row.lastSummary ? `- 上次运行的结果摘要：${neutralizeInjectionTags(row.lastSummary)}` : "- 这是第一次运行。",
    "- 做完后**必须**调用 clickin__schedule-finish 汇报：summary（给用户看的结果摘要，写清做了什么、发现了什么）、notify（这次是否值得通知用户——没有变化/无事可报填 false）、done（目标已一次性达成、任务可以停止时填 true）。",
  ].join("\n");
}

/** 认领到期任务并逐条触发。返回触发数。由 runner 节拍 / next 进程内定时调用。 */
export async function tickSchedules(startRun: StartRunFn, now = new Date()): Promise<number> {
  const pool = getPool();
  const claimed = await pool.query<Raw>(
    `UPDATE agent_schedule s SET lease_owner = $1, lease_until = $2::timestamptz + ($3::int * interval '1 millisecond')
     WHERE s.id IN (
       SELECT id FROM agent_schedule
       WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= $2::timestamptz
         AND (lease_until IS NULL OR lease_until < $2::timestamptz)
       ORDER BY next_fire_at LIMIT 20 FOR UPDATE SKIP LOCKED
     )
     RETURNING ${COLS}`,
    [RUNNER_OWNER, now, LEASE_MS],
  );
  let fired = 0;
  for (const raw of claimed.rows) {
    const row = toRow(raw);
    try {
      if (await fireSchedule(row, startRun, now)) fired++;
    } catch (err) {
      console.error(`[agent-schedule] fire ${row.id} failed:`, err);
      await advance(row, now).catch(() => {});
    } finally {
      await pool.query(`UPDATE agent_schedule SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2`, [row.id, RUNNER_OWNER]).catch(() => {});
    }
  }
  // 触发出的会话不占列表：过了归档期自动归档（历史/审计仍在）
  await pool.query(
    `UPDATE agent_session SET archived_at = now() WHERE schedule_id IS NOT NULL AND archived_at IS NULL AND updated_at < now() - ($1::int * interval '1 day')`,
    [AUTO_ARCHIVE_DAYS],
  ).catch(() => {});
  return fired;
}

/** 一次触发：前置门 → 开会话 → startRun → 推进时间表。返回是否真的起了 run。 */
async function fireSchedule(row: ScheduleRow, startRun: StartRunFn, now: Date): Promise<boolean> {
  // 前置门：终局性失败 → paused + 通知；不再往下
  const terminal = await terminalGate(row);
  if (terminal) {
    await pause(row, terminal);
    await notifyOwner(row, { title: `⏰ 定时任务《${row.name}》已暂停`, body: `原因：${terminal}。处理后可在对话里让 AI 恢复它。`, category: "warning", sessionId: null });
    return false;
  }
  // overlap：上一次还在跑 → 跳过本次
  if (row.lastRunId) {
    const r = await getPool().query<{ status: string }>(`SELECT status FROM agent_run WHERE id = $1`, [row.lastRunId]);
    if (r.rows[0] && ["running", "awaiting_approval", "awaiting_answer"].includes(r.rows[0].status)) {
      console.log(`[agent-schedule] ${row.id} skipped: previous run ${row.lastRunId} still active`);
      await advance(row, now);
      return false;
    }
  }
  const { PgSessionStorage } = await import("./pg-session-storage");
  const sessionId = createNewSessionKey(row.userId, row.productionId ?? undefined);
  await PgSessionStorage.create({ id: sessionId, userId: row.userId, productionId: row.productionId });
  await getPool().query(`UPDATE agent_session SET schedule_id = $2, title = $3 WHERE id = $1`, [sessionId, row.id, `⏰ ${row.name} · ${formatInTz(now)}`]);
  try {
    await startRun({ sessionId, userId: row.userId, message: buildScheduledMessage(row, now), pageKey: row.pageKey, scheduleId: row.id });
  } catch (err) {
    // 暂时性失败（额度用尽 429 / 运行时 503）：本次跳过，下次照常；空会话删掉
    await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [sessionId]).catch(() => {});
    const status = (err as { status?: number })?.status;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent-schedule] ${row.id} startRun failed (${status ?? "?"}):`, msg);
    await advance(row, now);
    await notifyOwner(row, { title: `⏰ 定时任务《${row.name}》本次未运行`, body: msg, category: "warning", sessionId: null });
    return false;
  }
  await advance(row, now);
  return true;
}

async function terminalGate(row: ScheduleRow): Promise<string | null> {
  const { getUserProfile } = await import("@/lib/db");
  if (!(await getUserProfile(row.userId))) return "创建者账号不存在";
  if (!row.productionId) return null;
  const { resolveProductionActor } = await import("@/lib/agent-tools/production-tools");
  const actor = await resolveProductionActor(row.userId, row.productionId);
  if (!actor) return "你已不是该制作的成员";
  if (actor.isArchived) return "该制作已归档";
  if (!(await productionFeatureAllowed(row.productionId, "ai"))) return "该制作的档位未开通 AI 助手";
  return null;
}

async function pause(row: ScheduleRow, reason: string): Promise<void> {
  await getPool().query(`UPDATE agent_schedule SET status = 'paused', paused_reason = $2, updated_at = now() WHERE id = $1`, [row.id, reason]);
}

/** 推进：计数 +1、算下一次；一次性 / 触发满 / 过期 → done。停机漏掉的只补这一次（下一次从 now 起算）。 */
async function advance(row: ScheduleRow, now: Date): Promise<void> {
  const planned = row.nextFireAt ?? now;
  let next = nextFireAt(row.schedule, planned);
  if (next && next.getTime() <= now.getTime()) next = nextFireAt(row.schedule, now);
  const fireCount = row.fireCount + 1;
  const done = !next || (row.maxFires != null && fireCount >= row.maxFires) || (row.expiresAt != null && next.getTime() > row.expiresAt.getTime());
  await getPool().query(
    `UPDATE agent_schedule SET fire_count = $2, last_fired_at = $3, next_fire_at = $4, status = $5, updated_at = now() WHERE id = $1`,
    [row.id, fireCount, now, next, done ? "done" : "active"],
  );
}

// ── 收尾（service 在 run 结束时调）──────────────────────────────────────────────

export interface ScheduleReport {
  summary?: string;
  notify?: boolean;
  done?: boolean;
  /** 模型要求的下一次间隔（毫秒；按最小间隔夹住） */
  nextInMs?: number;
}

export interface FinishScheduledRunInput {
  scheduleId: string;
  runId: string;
  sessionId: string;
  status: "completed" | "aborted" | "failed";
  error: string | null;
  lastAssistant: string | null;
  report: ScheduleReport | null;
}

/** run 结束：写回 last_run/last_summary、按汇报调整任务、通知创建者（附改动清单）。永不抛。 */
export async function finishScheduledRun(input: FinishScheduledRunInput): Promise<void> {
  try {
    const row = await getSchedule(input.scheduleId);
    if (!row) return;
    const mutations = await listRunMutations(input.runId).catch(() => [] as MutationRecord[]);
    const summary = (input.report?.summary?.trim() || input.lastAssistant?.trim() || (input.status === "completed" ? "（模型没有给出摘要）" : "")).slice(0, SUMMARY_MAX);
    const sets: string[] = ["last_run_id = $2", "last_summary = $3", "updated_at = now()"];
    const vals: unknown[] = [row.id, input.runId, summary];
    if (input.report?.done && row.status === "active") sets.push(`status = 'done'`);
    else if (input.report?.nextInMs && row.status === "active") {
      const { SCHEDULE_LIMITS } = await import("@/lib/plan");
      const ms = Math.max(SCHEDULE_LIMITS.minIntervalMs, Math.floor(input.report.nextInMs));
      vals.push(new Date(Date.now() + ms)); sets.push(`next_fire_at = $${vals.length}`);
    }
    await getPool().query(`UPDATE agent_schedule SET ${sets.join(", ")} WHERE id = $1`, vals);

    const failed = input.status !== "completed";
    // 静默条件：模型明确说不值得通知、且没有任何写、且没失败——有写必通知（先做后审）
    if (!failed && input.report?.notify === false && mutations.length === 0) return;
    const changeLines = mutations.slice(0, 10).map((m) => `- ${describeMutation(m)}`);
    if (mutations.length > 10) changeLines.push(`- …共 ${mutations.length} 项改动`);
    const body = [
      failed ? `本次运行${input.status === "aborted" ? "被中止" : "失败"}${input.error ? `：${input.error.slice(0, 200)}` : ""}` : null,
      summary || null,
      changeLines.length ? `改动：\n${changeLines.join("\n")}` : null,
      input.report?.done ? "任务已达成目标，自动结束。" : null,
    ].filter((l): l is string => !!l).join("\n\n");
    await notifyOwner(row, { title: `⏰ ${row.name}`, body, category: failed ? "warning" : "info", sessionId: input.sessionId });
  } catch (err) {
    console.error(`[agent-schedule] finish ${input.scheduleId} failed:`, err);
  }
}

/** 通知只投创建者。viewHref 带 agentSession 参数让 AgentPopout 直接打开那条会话。 */
async function notifyOwner(row: ScheduleRow, msg: { title: string; body: string; category: "info" | "warning"; sessionId: string | null }): Promise<void> {
  const { notifyUsers } = await import("@/lib/notify");
  const base = row.productionId ? `${SERVER_URL}/production/${row.productionId}` : `${SERVER_URL}/`;
  const viewHref = msg.sessionId ? `${base}?agentSession=${encodeURIComponent(msg.sessionId)}` : base;
  await notifyUsers({
    userIds: [row.userId],
    kind: "agent_schedule",
    productionId: row.productionId,
    entityType: "agent_schedule",
    entityId: row.id,
    title: msg.title,
    body: msg.body,
    viewHref,
    category: msg.category,
    buildExternalMessage: async (_userId, target) => ({
      title: msg.title,
      text: `${msg.title}\n${msg.body.slice(0, 800)}`,
      primaryUrl: target.adapter.buildActionUrl(viewHref),
    }),
  }).catch((err) => console.error(`[agent-schedule] notify ${row.id} failed:`, err));
}
