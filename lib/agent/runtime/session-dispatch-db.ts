import { getPool } from "@/lib/pg";
import type { InboxRow } from "./session-inbox";

/** 系统事件只在主会话模型轮次间认领，不由 HTTP 请求并发改写 transcript。 */
export async function pendingEventsForRun(
  sessionId: string,
  runId: string,
): Promise<InboxRow[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      sessionId,
    ]);
    const user = await client.query(
      `SELECT 1 FROM agent_session_inbox i WHERE i.session_id=$1
      AND kind='user_message' AND NOT EXISTS(SELECT 1 FROM agent_session_entry e
        WHERE e.session_id=i.session_id AND e.entry_id=i.id) LIMIT 1`,
      [sessionId],
    );
    if (user.rowCount) {
      await client.query("COMMIT");
      return [];
    }
    const result = await client.query<InboxRow>(
      `UPDATE agent_session_inbox i SET claimed_run_id=$2
    WHERE i.session_id=$1 AND i.kind='subagent_event' AND
      (i.claimed_run_id IS NULL OR i.claimed_run_id=$2 OR NOT EXISTS(
        SELECT 1 FROM agent_run r WHERE r.id=i.claimed_run_id
          AND r.status IN ('running','compacting','awaiting_approval','awaiting_answer')))
    RETURNING i.*`,
      [sessionId, runId],
    );
    await client.query("COMMIT");
    return result.rows.sort(
      (a, b) =>
        a.created_at.getTime() - b.created_at.getTime() ||
        a.id.localeCompare(b.id),
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 空闲唤醒与普通发起共用会话锁，并在库内认领输入。 */
export async function claimPendingSession(
  sessionId: string,
  runId: string,
  owner: string,
  model: string,
): Promise<InboxRow[] | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      sessionId,
    ]);
    const active = await client.query(
      `SELECT 1 FROM agent_run WHERE session_id=$1
      AND status IN ('running','compacting','awaiting_approval','awaiting_answer')`,
      [sessionId],
    );
    if (active.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const pending = await client.query<InboxRow>(
      `SELECT i.* FROM agent_session_inbox i
      WHERE session_id=$1 AND NOT EXISTS(SELECT 1 FROM agent_session_entry e
        WHERE e.session_id=i.session_id AND e.entry_id=i.id)
      ORDER BY CASE WHEN kind='user_message' THEN 0 ELSE 1 END,created_at,id FOR UPDATE`,
      [sessionId],
    );
    if (!pending.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const first = pending.rows[0];
    const budget =
      first.kind === "subagent_event"
        ? (first.payload[0]?.budgetRunId ?? null)
        : first.claimed_run_id
          ? ((
              await client.query<{ id: string }>(
                "SELECT COALESCE(budget_run_id,id) AS id FROM agent_run WHERE id=$1",
                [first.claimed_run_id],
              )
            ).rows[0]?.id ?? null)
          : null;
    await client.query(
      `INSERT INTO agent_run(id,session_id,status,owner,heartbeat_at,model,budget_run_id)
      VALUES($1,$2,'running',$3,now(),$4,$5)`,
      [runId, sessionId, owner, model, budget],
    );
    await client.query(
      "UPDATE agent_session_inbox SET claimed_run_id=$2 WHERE id=ANY($1::text[])",
      [pending.rows.map((r) => r.id), runId],
    );
    await client.query("COMMIT");
    return pending.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function sessionsWithPendingInputs(): Promise<string[]> {
  return (
    await getPool().query<{
      session_id: string;
    }>(`SELECT DISTINCT i.session_id FROM agent_session_inbox i
    WHERE NOT EXISTS(SELECT 1 FROM agent_session_entry e WHERE e.session_id=i.session_id AND e.entry_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM agent_subagent c WHERE c.id=i.session_id)`)
  ).rows.map((r) => r.session_id);
}
