// ask_user（#290 在自建运行时里的形态）：模型向用户提问 = 一个 await 表状态的工具。
// 与审批门同款机制（agent_question 表 + 轮询），重启后从表续；同一 toolCallId 已有待答
// 问题则接着等它，不重问（恢复路径把 ask_user 当只读工具重跑时天然幂等）。
// 卡片数据形态对齐 lib/agent-gateway/stream-reducer.ts 的 QuestionInfo——前端零改动。

import type { Pool } from "pg";
import { getPool } from "@/lib/pg";
import type { QuestionInfo, QuestionItem } from "@/lib/agent-gateway/stream-reducer";
import { newQuestionId } from "./ids";

const POLL_MS = 400;
export const QUESTION_TTL_MS = Number(process.env.AGENT_QUESTION_TTL_MS ?? 900_000);

export type QuestionOutcome =
  | { kind: "answered"; answers: Record<string, string[]> }
  | { kind: "cancelled" }
  | { kind: "expired" }
  /** 本进程脱离（排水），表状态原封不动，由下一个进程接着等 */
  | { kind: "detached" };

function toInfo(row: { id: string; payload: QuestionItem[]; expires_at: Date }): QuestionInfo {
  return { id: row.id, questions: row.payload, expiresAtMs: row.expires_at.getTime() };
}

/** 找同一 toolCallId 的待答问题（恢复/重跑时复用），没有就新建。 */
export async function createOrReuseQuestion(
  input: { runId: string; sessionId: string; toolCallId: string; questions: QuestionItem[] },
  pool: Pool = getPool(),
): Promise<QuestionInfo & { reused: boolean }> {
  const existing = await pool.query<{ id: string; payload: QuestionItem[]; expires_at: Date }>(
    `SELECT id, payload, expires_at FROM agent_question
     WHERE session_id = $1 AND tool_call_id = $2 AND status = 'pending' AND expires_at > now()`,
    [input.sessionId, input.toolCallId],
  );
  if (existing.rows[0]) return { ...toInfo(existing.rows[0]), reused: true };
  const id = newQuestionId();
  const expiresAt = new Date(Date.now() + QUESTION_TTL_MS);
  await pool.query(
    `INSERT INTO agent_question (id, run_id, session_id, tool_call_id, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [id, input.runId, input.sessionId, input.toolCallId, JSON.stringify(input.questions), expiresAt],
  );
  return { id, questions: input.questions, expiresAtMs: expiresAt.getTime(), reused: false };
}

export async function awaitQuestion(
  id: string, signal?: AbortSignal, pool: Pool = getPool(), opts: { isDetached?: () => boolean } = {},
): Promise<QuestionOutcome> {
  while (true) {
    if (signal?.aborted) {
      if (opts.isDetached?.()) return { kind: "detached" }; // 排水脱离：不碰表
      await pool.query(`UPDATE agent_question SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
      return { kind: "cancelled" };
    }
    const r = await pool.query<{ status: string; answer: Record<string, string[]> | null; expires_at: Date }>(
      `SELECT status, answer, expires_at FROM agent_question WHERE id = $1`, [id],
    );
    const row = r.rows[0];
    if (!row) return { kind: "cancelled" };
    if (row.status === "answered") return { kind: "answered", answers: row.answer ?? {} };
    if (row.status === "cancelled") return { kind: "cancelled" };
    if (row.status === "expired" || row.expires_at.getTime() < Date.now()) {
      await pool.query(`UPDATE agent_question SET status = 'expired', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
      return { kind: "expired" };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** 会话的待答问题（重开会话时恢复卡片）。 */
export async function listPendingQuestions(sessionId: string, pool: Pool = getPool()): Promise<QuestionInfo[]> {
  const r = await pool.query<{ id: string; payload: QuestionItem[]; expires_at: Date }>(
    `SELECT id, payload, expires_at FROM agent_question WHERE session_id = $1 AND status = 'pending' AND expires_at > now() ORDER BY created_at`,
    [sessionId],
  );
  return r.rows.map(toInfo);
}

/** 所有权用：问题归属的会话（不存在/已结束 → undefined）。 */
export async function questionSession(id: string, pool: Pool = getPool()): Promise<string | undefined> {
  const r = await pool.query<{ session_id: string }>(
    `SELECT session_id FROM agent_question WHERE id = $1 AND status = 'pending' AND expires_at > now()`, [id],
  );
  return r.rows[0]?.session_id;
}

export async function resolveQuestion(
  id: string, resolution: { answers: Record<string, string[]> } | { cancel: true }, pool: Pool = getPool(),
): Promise<boolean> {
  const r = "cancel" in resolution
    ? await pool.query(`UPDATE agent_question SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id])
    : await pool.query(`UPDATE agent_question SET status = 'answered', answer = $2::jsonb, resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id, JSON.stringify(resolution.answers)]);
  return (r.rowCount ?? 0) > 0;
}

/** 答案 → 给模型看的文本。 */
export function formatAnswers(questions: QuestionItem[], answers: Record<string, string[]>): string {
  const lines = questions.map((q) => {
    const a = answers[q.questionId];
    return `- ${q.header}：${a && a.length > 0 ? a.join("、") : "（未回答）"}`;
  });
  return `用户的回答：\n${lines.join("\n")}`;
}
