import { getPool } from "@/lib/pg";
import { newRunId } from "./ids";
import { RUNNER_OWNER } from "./config";
import { ADMISSION_PRIORITY, type AdmissionResource, type AdmissionTicket, type InputWait } from "./admission-types";
import type { AssistantMessage } from "../../../vendor/openclaw/packages/llm-core/src/types";

export async function requestAdmission(runId: string, key: string, resource: AdmissionResource): Promise<AdmissionTicket> {
  const r = await getPool().query<AdmissionTicket>(
    `INSERT INTO agent_admission(id,run_id,operation_key,resource) VALUES($1,$2,$3,$4)
     ON CONFLICT(run_id,operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key,
       ready_at=CASE WHEN agent_admission.resource<>'mmp' AND agent_admission.state='failed' THEN now() ELSE agent_admission.ready_at END,
       state=CASE WHEN agent_admission.resource<>'mmp' AND agent_admission.state='failed' THEN 'ready' ELSE agent_admission.state END RETURNING *`,
    [newRunId(), runId, key, resource],
  );
  return r.rows[0];
}

/** 只有名额分配使用短锁；模型、工具和网络等待不持事务或连接。 */
export async function claimAdmissions(resource: AdmissionResource, limit: number, agingMs: number, ids: string[]): Promise<AdmissionTicket[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-admission'))");
    const count = await client.query<{ n: string }>(
      "SELECT count(*)::text n FROM agent_admission WHERE resource=$1 AND state IN ('active','unknown')", [resource],
    );
    const free = Math.max(0, limit - Number(count.rows[0].n));
    const r = await client.query<AdmissionTicket>(
      `WITH candidates AS (
        SELECT a.id FROM agent_admission a JOIN agent_run r ON r.id=a.run_id
        WHERE a.resource=$1 AND a.state='ready' AND a.id=ANY($4::text[])
          AND r.status IN ('queued','running','compacting','awaiting_approval','awaiting_answer')
        ORDER BY GREATEST(
          ($6::jsonb->>r.admission_class)::int
            + CASE WHEN r.admission_class='interactive' THEN 0 ELSE extract(epoch FROM(now()-a.ready_at))*1000/$3 END,
          COALESCE((SELECT max(($6::jsonb->>p.admission_class)::int
            + CASE WHEN pa.state='ready' AND p.admission_class<>'interactive' THEN extract(epoch FROM (now()-pa.ready_at))*1000/$3 ELSE 0 END)
            FROM agent_run p JOIN agent_admission pa ON pa.run_id=p.id AND pa.resource='context'
            WHERE p.input_wait->'ids' ? r.session_id
              AND p.status IN ('running','awaiting_answer')),0))
          DESC,a.ready_at,a.id
        LIMIT $2 FOR UPDATE OF a
      ) UPDATE agent_admission a SET state='active',owner=$5,heartbeat_at=now(),started_at=COALESCE(started_at,now())
        FROM candidates c WHERE a.id=c.id RETURNING a.*`,
      [resource, free, agingMs, ids, RUNNER_OWNER,JSON.stringify(ADMISSION_PRIORITY)],
    );
    await client.query("COMMIT");
    return r.rows;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function finishAdmission(id: string, state: "done" | "failed" | "unknown" = "done", result?: unknown): Promise<void> {
  await getPool().query(
    `UPDATE agent_admission SET state=$2,result=COALESCE($3::jsonb,result) WHERE id=$1`,
    [id, state, result === undefined ? null : JSON.stringify(result)],
  );
}
export async function admissionRemoteId(id: string, remoteId: string): Promise<void> {
  await getPool().query("UPDATE agent_admission SET remote_id=$2 WHERE id=$1", [id, remoteId]);
}
export async function reattachAdmission(id: string): Promise<void> {
  await getPool().query("UPDATE agent_admission SET state='active',owner=$2,heartbeat_at=now() WHERE id=$1", [id,RUNNER_OWNER]);
}
export async function heartbeatAdmissions(ids: string[]): Promise<void> {
  await getPool().query("UPDATE agent_admission SET heartbeat_at=now() WHERE id=ANY($1::text[]) AND owner=$2 AND state='active'", [ids, RUNNER_OWNER]);
}
export async function recoverAdmissions(orphanMs: number): Promise<void> {
  await getPool().query(
    `UPDATE agent_admission SET state=CASE WHEN resource='mmp' THEN 'unknown' ELSE 'failed' END
     WHERE state='active' AND (heartbeat_at IS NULL OR heartbeat_at<now()-$1*interval '1 millisecond')`, [orphanMs],
  );
}
export async function setInputWait(runId: string, wait: InputWait | null): Promise<void> {
  await getPool().query("UPDATE agent_run SET input_wait=$2::jsonb WHERE id=$1", [runId, wait ? JSON.stringify(wait) : null]);
}
export async function inputWaitReady(wait: InputWait): Promise<boolean> {
  if (wait.kind === "all") return (await Promise.all(wait.waits.map(inputWaitReady))).every(Boolean);
  if (wait.kind === "subagent") {
    if (Date.now() >= wait.deadline) return true;
    const r = await getPool().query(
      `SELECT 1 FROM agent_run r JOIN agent_subagent c ON c.id=r.subagent_id
       WHERE r.session_id=ANY($1::text[]) AND c.context_request IS NULL AND NOT c.stopped
         AND r.status IN ('queued','running','compacting')`, [wait.ids],
    );
    return !r.rowCount;
  }
  const table = wait.kind === "question" ? "agent_question" : "agent_approval";
  const r = await getPool().query<{ ready: boolean }>(`SELECT status<>'pending' OR expires_at<=now() AS ready FROM ${table} WHERE id=$1`, [wait.id]);
  return r.rows[0]?.ready ?? true;
}
export async function cancelAdmissions(runId: string): Promise<void> {
  // 远端任务的取消需确认终态，不能在这里只释放名额。
  await getPool().query("UPDATE agent_admission SET state='failed' WHERE run_id=$1 AND state='ready'", [runId]);
}
export async function admissionMetrics(): Promise<unknown[]> {
  return (await getPool().query("SELECT resource,state,count(*)::int count FROM agent_admission WHERE state IN ('ready','active','unknown') GROUP BY resource,state")).rows;
}
export async function unknownMmpAdmissions(): Promise<Array<AdmissionTicket & { run_status: string }>> {
  return (await getPool().query<AdmissionTicket & { run_status: string }>(
    "SELECT a.*,r.status AS run_status FROM agent_admission a JOIN agent_run r ON r.id=a.run_id WHERE a.resource='mmp' AND a.state='unknown' AND a.remote_id IS NOT NULL",
  )).rows;
}

export async function previousInputWait(runId: string): Promise<InputWait | null> {
  return (await getPool().query<{ input_wait: InputWait | null }>("SELECT input_wait FROM agent_run WHERE id=$1", [runId])).rows[0]?.input_wait ?? null;
}
export async function runSessionId(runId: string): Promise<string | undefined> {
  return (await getPool().query<{ session_id: string }>("SELECT session_id FROM agent_run WHERE id=$1", [runId])).rows[0]?.session_id;
}
export async function continuationKey(runId: string): Promise<string> {
  const r = await getPool().query<{ entry_id: string }>(`SELECT e.entry_id FROM agent_session_entry e JOIN agent_run r ON r.session_id=e.session_id
    WHERE r.id=$1 ORDER BY e.seq DESC LIMIT 1`, [runId]);
  return r.rows[0]?.entry_id ?? runId;
}
export async function completedChatMessages(runId: string): Promise<AssistantMessage[]> {
  const rows = await getPool().query<{ result: AssistantMessage }>(
    "SELECT result FROM agent_admission WHERE run_id=$1 AND resource='llm' AND state='done' AND operation_key LIKE 'llm:%' AND result IS NOT NULL", [runId],
  );
  return rows.rows.map((row) => row.result);
}
export async function completedToolResult(runId: string, callId: string): Promise<unknown> {
  return (await getPool().query("SELECT result FROM agent_tool_operation WHERE run_id=$1 AND tool_call_id=$2", [runId,callId])).rows[0]?.result;
}
export async function beginToolOperation(runId: string, callId: string): Promise<void> {
  await getPool().query(`INSERT INTO agent_tool_operation(id,run_id,tool_call_id,execution_epoch)
    SELECT $1,id,$3,execution_epoch FROM agent_run WHERE id=$2
    ON CONFLICT(run_id,tool_call_id) DO UPDATE SET execution_epoch=EXCLUDED.execution_epoch WHERE agent_tool_operation.result IS NULL`, [newRunId(),runId,callId]);
}
export async function saveToolResult(runId: string, callId: string, result: unknown): Promise<void> {
  await getPool().query(`UPDATE agent_tool_operation o SET result=$3::jsonb FROM agent_run r
    WHERE o.run_id=$1 AND o.tool_call_id=$2 AND r.id=o.run_id AND r.execution_epoch=o.execution_epoch AND r.owner=$4`, [runId,callId,JSON.stringify(result),RUNNER_OWNER]);
}
