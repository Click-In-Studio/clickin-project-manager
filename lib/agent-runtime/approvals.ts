// 写工具确认门（#367 S2）：进程内 await **表状态**，不是内存 promise——重启后
// 等待态从 agent_approval 续（§4.4 ①"等待审批：什么都不用做"）。
//
// 语义继承网关时代（project_ai_infra「工具调用权限门原则」）：非只读工具一律先卡，
// allow-once / deny；deny 的理由随工具结果回给模型（同帧，不靠 steer）。
//
// 曾经还有一个 allow-always，但它从未被送到前端（allowedDecisions 恒为
// ["allow-once","deny"]），持久化也一直是挂账——按 allow-once 处理的"始终允许"只会
// 骗人。整条枝摘掉；真要做，做的是持久化那一半，不是把字面量加回来。
// `decision` 列仍是字符串列，历史行（若有）读出来一律按 allow-once 处理。

import type { Pool } from "pg";
import { getPool } from "@/lib/pg";
import type { ApprovalInfo } from "@/lib/agent-chat/stream-reducer";
import { newApprovalId } from "./ids";
import { APPROVAL_TTL_MS } from "./config";

export type ApprovalDecision = "allow-once" | "deny";
export type ApprovalOutcome =
  | { kind: "allowed"; decision: Exclude<ApprovalDecision, "deny"> }
  | { kind: "denied"; reason: string | null }
  | { kind: "expired" }
  /** 本进程脱离（排水），表状态原封不动，由下一个进程接着等 */
  | { kind: "detached" };

const POLL_MS = 400;

export interface ApprovalCard {
  title: string;
  description: string;
  severity: ApprovalInfo["severity"];
}

export async function createApproval(
  input: { runId: string; sessionId: string; toolCallId: string; tool: string; args: unknown; card: ApprovalCard; preview?: Record<string, unknown> },
  pool: Pool = getPool(),
): Promise<{ id: string; info: ApprovalInfo; expiresAt: Date; reused: boolean }> {
  // 同一 toolCallId 已有待答（或已批未执行）的审批 → 复用：进程重启后恢复重跑同一个
  // 工具调用时不再弹第二张卡（§4.4 ①"等待审批：什么都不用做"）
  const existing = await pool.query<{ id: string; preview: ApprovalCard; expires_at: Date }>(
    `SELECT id, preview, expires_at FROM agent_approval
     WHERE session_id = $1 AND tool_call_id = $2 AND expires_at > now()
       AND (status = 'pending' OR (status = 'allowed' AND executed_at IS NULL))`,
    [input.sessionId, input.toolCallId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      id: row.id, expiresAt: row.expires_at, reused: true,
      info: { id: row.id, title: row.preview.title ?? input.card.title, description: row.preview.description ?? input.card.description,
        severity: row.preview.severity ?? input.card.severity, allowedDecisions: ["allow-once", "deny"], toolCallId: input.toolCallId },
    };
  }
  const id = newApprovalId();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  await pool.query(
    `INSERT INTO agent_approval (id, run_id, session_id, tool_call_id, tool, args, preview, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [id, input.runId, input.sessionId, input.toolCallId, input.tool, JSON.stringify(input.args ?? {}),
     JSON.stringify({ ...input.card, ...(input.preview ?? {}) }), expiresAt],
  );
  const info: ApprovalInfo = {
    id,
    title: input.card.title.slice(0, 80),
    description: input.card.description.slice(0, 512),
    severity: input.card.severity,
    allowedDecisions: ["allow-once", "deny"],
    toolCallId: input.toolCallId,
  };
  return { id, info, expiresAt, reused: false };
}

/** 某个工具调用能否在恢复时重跑：待答审批（还没执行）或已批未执行 → 可以；
 *  已开始执行（executed_at 有值）→ 副作用未知，不能。 */
export async function approvalAllowsReexecute(sessionId: string, toolCallId: string, pool: Pool = getPool()): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM agent_approval WHERE session_id = $1 AND tool_call_id = $2 AND expires_at > now()
       AND (status = 'pending' OR (status = 'allowed' AND executed_at IS NULL))`,
    [sessionId, toolCallId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 轮询表状态直到有决议/过期/中止。轮询而非 LISTEN：审批是分钟级人类动作，400ms 足够。 */
export async function awaitApproval(
  id: string, signal?: AbortSignal, pool: Pool = getPool(), opts: { isDetached?: () => boolean } = {},
): Promise<ApprovalOutcome> {
  while (true) {
    if (signal?.aborted) {
      if (opts.isDetached?.()) return { kind: "detached" }; // 排水脱离：不碰表
      await pool.query(`UPDATE agent_approval SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
      return { kind: "denied", reason: "本轮已中止" };
    }
    const r = await pool.query<{ status: string; decision: string | null; reason: string | null; expires_at: Date }>(
      `SELECT status, decision, reason, expires_at FROM agent_approval WHERE id = $1`, [id],
    );
    const row = r.rows[0];
    if (!row) return { kind: "denied", reason: "审批记录不存在" };
    if (row.status === "allowed") return { kind: "allowed", decision: "allow-once" };
    if (row.status === "denied") return { kind: "denied", reason: row.reason };
    if (row.status === "cancelled") return { kind: "denied", reason: row.reason ?? "已取消" };
    if (row.status === "expired" || row.expires_at.getTime() < Date.now()) {
      await pool.query(`UPDATE agent_approval SET status = 'expired', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
      return { kind: "expired" };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** 所有权用：审批归属的会话（过期/不存在 → undefined，与网关时代语义一致）。 */
export async function approvalSession(id: string, pool: Pool = getPool()): Promise<string | undefined> {
  const r = await pool.query<{ session_id: string; status: string }>(
    `SELECT session_id, status FROM agent_approval WHERE id = $1 AND status = 'pending' AND expires_at > now()`, [id],
  );
  return r.rows[0]?.session_id;
}

export async function resolveApproval(
  id: string, decision: ApprovalDecision, resolvedBy: string, reason?: string, pool: Pool = getPool(),
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE agent_approval
     SET status = $2, decision = $3, reason = $4, resolved_by = $5, resolved_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, decision === "deny" ? "denied" : "allowed", decision, reason ?? null, resolvedBy],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function markApprovalExecuted(id: string, pool: Pool = getPool()): Promise<void> {
  await pool.query(`UPDATE agent_approval SET executed_at = now() WHERE id = $1`, [id]);
}
