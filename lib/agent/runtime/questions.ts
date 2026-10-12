// ask_user 的持久状态。required 会在原工具调用里等待；continue_independent 会立刻把
// pending 结果交回模型，迟到回答再经 session inbox 进入当前或后续 run。

import type { Pool, PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { EVENT_CHANNEL, subscribeDecisionEvents } from "./events";
import { EVENT_FALLBACK_MS, EventWakeup } from "./event-wakeup";
import type { QuestionContinuation, QuestionInfo, QuestionItem, QuestionWaitMode } from "@/lib/agent/chat/stream-reducer";
import { newInboxId, newQuestionId } from "./ids";

export const QUESTION_TTL_MS = Number(process.env.AGENT_QUESTION_TTL_MS ?? 900_000);

export type QuestionOutcome =
  | { kind: "answered"; answers: Record<string, string[]> }
  | { kind: "cancelled" }
  | { kind: "expired" }
  | { kind: "detached" };

type QuestionRow = {
  id: string; run_id: string; session_id: string; tool_call_id: string;
  payload: QuestionItem[]; answer: Record<string, string[]> | null;
  wait_mode: QuestionWaitMode; continuation: QuestionContinuation | Record<string, never>;
  cancellation_reason: string | null; status: QuestionInfo["status"];
  expires_at: Date | null; created_at: Date; resolved_at: Date | null;
  run_status?: string;
};

const QUESTION_COLUMNS = `id,run_id,session_id,tool_call_id,payload,answer,wait_mode,
  continuation,cancellation_reason,status,expires_at,created_at,resolved_at`;

function toInfo(row: QuestionRow): QuestionInfo {
  const continuation = row.wait_mode === "continue_independent" ? row.continuation as QuestionContinuation : undefined;
  return {
    id: row.id, toolCallId: row.tool_call_id, questions: row.payload, waitMode: row.wait_mode,
    ...(continuation ? { continuation } : {}), status: row.status,
    ...(row.answer ? { answer: row.answer } : {}),
    ...(row.cancellation_reason ? { cancellationReason: row.cancellation_reason } : {}),
    createdAtMs: row.created_at.getTime(),
    ...(row.resolved_at ? { resolvedAtMs: row.resolved_at.getTime() } : {}),
    ...(row.expires_at ? { expiresAtMs: row.expires_at.getTime() } : {}),
    ...(row.run_status ? { originRunStatus: row.run_status } : {}),
  };
}

/** 同一会话里的 toolCallId 唯一；并发恢复也只会得到同一问题。 */
export async function createOrReuseQuestion(
  input: { runId: string; sessionId: string; toolCallId: string; questions: QuestionItem[];
    waitMode?: QuestionWaitMode; continuation?: QuestionContinuation },
  pool: Pool = getPool(),
): Promise<QuestionInfo & { reused: boolean }> {
  const waitMode = input.waitMode ?? "required";
  const expiresAt = waitMode === "required" ? new Date(Date.now() + QUESTION_TTL_MS) : null;
  const inserted = await pool.query<QuestionRow>(
    `INSERT INTO agent_question
       (id,run_id,session_id,tool_call_id,payload,wait_mode,continuation,expires_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)
     ON CONFLICT (session_id,tool_call_id) DO NOTHING RETURNING ${QUESTION_COLUMNS}`,
    [newQuestionId(),input.runId,input.sessionId,input.toolCallId,JSON.stringify(input.questions),waitMode,
      JSON.stringify(input.continuation ?? {}),expiresAt],
  );
  if (inserted.rows[0]) return { ...toInfo(inserted.rows[0]), reused: false };
  const existing = await pool.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM agent_question WHERE session_id=$1 AND tool_call_id=$2`,
    [input.sessionId,input.toolCallId],
  );
  if (!existing.rows[0]) throw new Error("提问创建冲突后未找到原问题");
  return { ...toInfo(existing.rows[0]), reused: true };
}

export async function awaitQuestion(
  id: string, signal?: AbortSignal, pool: Pool = getPool(), opts: { isDetached?: () => boolean } = {},
): Promise<QuestionOutcome> {
  const wakeup = new EventWakeup(signal);
  let unsubscribe: (() => void) | undefined;
  try {
    if (!signal?.aborted) unsubscribe = await subscribeDecisionEvents("question", id, wakeup.wake);
    while (true) {
      if (signal?.aborted) {
        if (opts.isDetached?.()) return { kind: "detached" };
        await pool.query(
          `UPDATE agent_question SET status = 'cancelled',cancellation_reason='原任务已停止',resolved_at=now()
           WHERE id=$1 AND status='pending'`, [id],
        );
        return { kind: "cancelled" };
      }
      const r = await pool.query<{ status: string; answer: Record<string, string[]> | null; expires_at: Date | null }>(
        `SELECT status,answer,expires_at FROM agent_question WHERE id=$1`, [id],
      );
      if (signal?.aborted) continue;
      const row = r.rows[0];
      if (!row) return { kind: "cancelled" };
      if (row.status === "answered") return { kind: "answered", answers: row.answer ?? {} };
      if (row.status === "cancelled") return { kind: "cancelled" };
      if (row.status === "expired" || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
        await pool.query(`UPDATE agent_question SET status = 'expired',resolved_at=now() WHERE id=$1 AND status='pending'`, [id]);
        return { kind: "expired" };
      }
      const waitMs = row.expires_at
        ? Math.max(0,Math.min(EVENT_FALLBACK_MS,row.expires_at.getTime()-Date.now()))
        : EVENT_FALLBACK_MS;
      await wakeup.wait(waitMs);
    }
  } finally {
    unsubscribe?.();
    wakeup.close();
  }
}

/** 历史与待答卡片共同从表恢复；toolCallId 负责把卡片放回原对话位置。 */
export async function listQuestions(sessionId: string, pool: Pool = getPool()): Promise<QuestionInfo[]> {
  await pool.query(
    `UPDATE agent_question SET status='expired',resolved_at=now()
     WHERE session_id=$1 AND status='pending' AND expires_at IS NOT NULL AND expires_at<=now()`, [sessionId],
  );
  const r = await pool.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS},(SELECT status FROM agent_run r WHERE r.id=agent_question.run_id) AS run_status
     FROM agent_question WHERE session_id=$1 ORDER BY created_at,id`, [sessionId],
  );
  return r.rows.map(toInfo);
}

export async function listPendingQuestions(sessionId: string, pool: Pool = getPool()): Promise<QuestionInfo[]> {
  return (await listQuestions(sessionId,pool)).filter((question) => question.status === "pending");
}

/** 所有权只允许仍可作答的问题；已决议与已过期统一不可探测。 */
export async function questionSession(id: string, pool: Pool = getPool()): Promise<string | undefined> {
  const r = await pool.query<{ session_id: string }>(
    `SELECT session_id FROM agent_question
     WHERE id=$1 AND status='pending' AND (expires_at IS NULL OR expires_at>now())`, [id],
  );
  return r.rows[0]?.session_id;
}

function formatDeferredInput(row: QuestionRow, resolution: { answers: Record<string, string[]> } | { cancel: true }): string {
  const original = row.payload.map((q) => `${q.header}：${q.question}`).join("\n");
  const result = "cancel" in resolution ? "用户取消了这次待补充提问。" : formatAnswers(row.payload,resolution.answers);
  const continuation = row.continuation as QuestionContinuation;
  return [
    "<clickin-question-answer>",
    `问题 id：${row.id}；原工具调用 id：${row.tool_call_id}`,
    "这是用户对先前待补充问题的迟到回应，只调整尚未完成的工作；不要自动撤销已经落地的业务写入。",
    `原问题：\n${neutralizeInjectionTags(original)}`,
    `此前可继续的独立工作：${neutralizeInjectionTags(continuation.continueWith)}`,
    `此前明确等待回答的工作：${neutralizeInjectionTags(continuation.blockedUntilAnswer)}`,
    "</clickin-question-answer>",
    neutralizeInjectionTags(result),
  ].join("\n");
}

async function resolveQuestionInTx(
  client: PoolClient, id: string, resolution: { answers: Record<string, string[]> } | { cancel: true },
): Promise<QuestionInfo | undefined> {
  const selected = await client.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM agent_question
     WHERE id=$1 AND status='pending' AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE`, [id],
  );
  const row = selected.rows[0];
  if (!row) return undefined;
  const cancelled = "cancel" in resolution;
  const updated = await client.query<QuestionRow>(
    `UPDATE agent_question SET status=$2,answer=$3::jsonb,cancellation_reason=$4,resolved_at=now()
     WHERE id=$1 RETURNING ${QUESTION_COLUMNS}`,
    [id,cancelled ? "cancelled" : "answered",cancelled ? null : JSON.stringify(resolution.answers),
      cancelled ? "用户取消了提问" : null],
  );
  if (row.wait_mode === "continue_independent") {
    const activeRun = (await client.query<{ id: string }>(
      `SELECT id FROM agent_run WHERE session_id=$1
       AND status IN ('queued','running','compacting','awaiting_approval','awaiting_answer')
       ORDER BY started_at DESC,id DESC LIMIT 1`, [row.session_id],
    )).rows[0]?.id ?? null;
    // 空闲会话里“取消提问”只关闭卡片，不值得单独启动一次模型调用；若原任务仍在跑，
    // 则把取消送到安全边界，让它停止等待中的依赖工作。
    if (!cancelled || activeRun) {
      await client.query(
        `INSERT INTO agent_session_inbox(id,session_id,claimed_run_id,message,attachment_ids,kind,payload)
         VALUES($1,$2,$3,$4,'[]'::jsonb,'user_message',$5::jsonb)`,
        [newInboxId(),row.session_id,activeRun,formatDeferredInput(row,resolution),JSON.stringify({
          questionAnswer: { questionId: row.id,toolCallId: row.tool_call_id,
            resolution: cancelled ? "cancelled" : "answered",
            ...(cancelled ? {} : { answers: resolution.answers }) },
        })],
      );
    }
    await client.query("UPDATE agent_session SET updated_at=now() WHERE id=$1", [row.session_id]);
  }
  await client.query("SELECT pg_notify($1,$2)", [EVENT_CHANNEL,`question:${id}:0`]);
  return toInfo(updated.rows[0]);
}

export async function resolveQuestionDetailed(
  id: string, resolution: { answers: Record<string, string[]> } | { cancel: true }, pool: Pool = getPool(),
): Promise<QuestionInfo | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await resolveQuestionInTx(client,id,resolution);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveQuestion(
  id: string, resolution: { answers: Record<string, string[]> } | { cancel: true }, pool: Pool = getPool(),
): Promise<boolean> {
  return Boolean(await resolveQuestionDetailed(id,resolution,pool));
}

/** 停止只结束这些 run 发起的问题，不扫掉会话里其他已延期的决定。 */
export async function cancelQuestionsForRuns(
  runIds: string[], reason: string, pool: Pool = getPool(),
): Promise<string[]> {
  if (runIds.length === 0) return [];
  const r = await pool.query<{ id: string }>(
    `UPDATE agent_question SET status='cancelled',cancellation_reason=$2,resolved_at=now()
     WHERE run_id=ANY($1::text[]) AND status='pending' RETURNING id`, [runIds,reason],
  );
  return r.rows.map((row) => row.id);
}

/** 崩溃发生在 deferred 工具结果落 transcript 之前时，恢复会直接把已到答案补成工具结果；
 * 此时删掉尚未消费的同一答案 inbox，避免下一轮再注入一次。 */
export async function consumeDeferredResolutionInbox(questionId: string, pool: Pool = getPool()): Promise<boolean> {
  const r=await pool.query(
    `DELETE FROM agent_session_inbox
     WHERE kind='user_message' AND payload->'questionAnswer'->>'questionId'=$1`, [questionId],
  );
  return Boolean(r.rowCount);
}

export function formatAnswers(questions: QuestionItem[], answers: Record<string, string[]>): string {
  const lines = questions.map((q) => {
    const answer = answers[q.questionId];
    return `- ${q.header}：${answer && answer.length>0 ? answer.join("、") : "（未回答）"}`;
  });
  return `用户的回答：\n${lines.join("\n")}`;
}
