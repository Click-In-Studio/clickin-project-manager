import { getPool } from "@/lib/pg";
export async function sessionRuntimeStatus(
  sessionId: string,
): Promise<string | null> {
  return (
    (
      await getPool().query<{ status: string }>(
        `SELECT status FROM agent_run WHERE session_id=$1
    AND status IN ('running','compacting','awaiting_approval','awaiting_answer') ORDER BY started_at DESC LIMIT 1`,
        [sessionId],
      )
    ).rows[0]?.status ?? null
  );
}

export async function rootSessionIdentity(sessionId: string) {
  return (
    (
      await getPool().query<{ user_id: string; production_id: string | null }>(
        `SELECT user_id,production_id FROM agent_session s WHERE id=$1
      AND NOT EXISTS(SELECT 1 FROM agent_subagent c WHERE c.id=s.id)`,
        [sessionId],
      )
    ).rows[0] ?? null
  );
}

export async function runPaidFrom(
  runId: string,
): Promise<import("@/lib/agent/ai-quota").PaidFrom | null> {
  return (
    (
      await getPool().query<{
        paid_from: import("@/lib/agent/ai-quota").PaidFrom | null;
      }>(
        `SELECT COALESCE(b.paid_from,r.paid_from) AS paid_from
    FROM agent_run r LEFT JOIN agent_run b ON b.id=r.budget_run_id WHERE r.id=$1`,
        [runId],
      )
    ).rows[0]?.paid_from ?? null
  );
}

export async function setRunPaidFrom(
  runId: string,
  paidFrom: import("@/lib/agent/ai-quota").PaidFrom,
): Promise<void> {
  await getPool().query("UPDATE agent_run SET paid_from=$2 WHERE id=$1", [
    runId,
    paidFrom,
  ]);
}
