import { getPool } from "@/lib/pg";
import { newInboxId } from "./ids";

export type InboxRow = {
  id: string;
  session_id: string;
  claimed_run_id: string | null;
  message: string;
  attachment_ids: string[];
  created_at: Date;
};

/** 压缩期间的用户输入先落库；成功返回即代表 runner 切换阶段或重启也不会丢。 */
export async function enqueueSessionInput(input: {
  sessionId: string;
  runId: string;
  message: string;
  attachmentIds: string[];
}): Promise<string | null> {
  const id = newInboxId();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.sessionId]);
    const inserted = await client.query(
      `INSERT INTO agent_session_inbox (id, session_id, claimed_run_id, message, attachment_ids)
       SELECT $1, $2, $3, $4, $5::jsonb
       WHERE EXISTS (
         SELECT 1 FROM agent_run
          WHERE id = $3 AND session_id = $2
            AND status = 'compacting'
       )
       RETURNING id`,
      [id, input.sessionId, input.runId, input.message, JSON.stringify(input.attachmentIds)],
    );
    await client.query("COMMIT");
    return inserted.rowCount ? id : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** transcript 已有同 id 的 user message 即代表 exactly-once 消费完成。 */
export async function reconcileConsumedInputs(sessionId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM agent_session_inbox i USING agent_session_entry e
     WHERE i.session_id = $1
       AND e.session_id = i.session_id
       AND e.entry_id = i.id
       AND e.type = 'message'`,
    [sessionId],
  );
}

/** 当前 run 可消费自身认领的输入；孤儿接管沿用同一 run id，因此无需改写认领。 */
export async function pendingInputsForRun(sessionId: string, runId: string): Promise<InboxRow[]> {
  const r = await getPool().query<InboxRow>(
    `SELECT id, session_id, claimed_run_id, message, attachment_ids, created_at
       FROM agent_session_inbox
      WHERE session_id = $1 AND claimed_run_id = $2
      ORDER BY created_at, id`,
    [sessionId, runId],
  );
  return r.rows;
}

export async function pendingInputsForSession(sessionId: string): Promise<InboxRow[]> {
  const r = await getPool().query<InboxRow>(
    `SELECT i.id, i.session_id, i.claimed_run_id, i.message, i.attachment_ids, i.created_at
       FROM agent_session_inbox i
      WHERE i.session_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM agent_session_entry e
           WHERE e.session_id = i.session_id AND e.entry_id = i.id AND e.type = 'message'
        )
      ORDER BY i.created_at, i.id`,
    [sessionId],
  );
  return r.rows;
}

/**
 * 与入队共用会话锁：只有调用方已经预检的 id 与当前队列完全相等，才把 run
 * 切回 running；否则返回最新快照，让调用方补完预检后重试。
 */
export async function finishCompactionAndListInputs(
  sessionId: string,
  runId: string,
  expectedIds: string[],
): Promise<{ finished: boolean; rows: InboxRow[] }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [sessionId]);
    const rows = await client.query<InboxRow>(
      `SELECT id, session_id, claimed_run_id, message, attachment_ids, created_at
         FROM agent_session_inbox
        WHERE session_id = $1 AND claimed_run_id = $2
        ORDER BY created_at, id`,
      [sessionId, runId],
    );
    const ids = rows.rows.map((row) => row.id);
    const finished = ids.length === expectedIds.length && ids.every((id, index) => id === expectedIds[index]);
    if (finished) {
      await client.query(
        `UPDATE agent_run SET status = 'running' WHERE id = $1 AND status = 'compacting'`,
        [runId],
      );
    }
    await client.query("COMMIT");
    return { finished, rows: rows.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
