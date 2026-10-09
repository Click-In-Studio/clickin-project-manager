import { getPool } from "@/lib/pg";
import { newRunId, newSessionId } from "./ids";
import { CHAT_MODEL, RUNNER_OWNER } from "./config";
import { RUN_CREDIT_HARD_CAP, creditsFromUsd } from "@/lib/account/plan";
import type { SubagentSource, SubagentView } from "./subagent-types";

const ACTIVE = "('running','compacting','awaiting_approval','awaiting_answer')";
export const SUBAGENT_CONCURRENCY = 2;
export const SUBAGENT_USER_CONCURRENCY = 4;
export const SUBAGENT_QUEUE_DEPTH = 8;

export interface SubagentJob {
  id: string;
  session_id: string;
  subagent_id: string;
  parent_session_id: string;
  budget_run_id: string;
  user_id: string;
  production_id: string | null;
  task: string;
  completion_criteria: string;
  initial_message: string;
  execution_started_at: Date;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  result: string | null;
  context_request: string | null;
}

/** 创建与追问共用队列；主会话身份从活动 run 取得，模型不能传入身份。 */
export async function queueSubagent(input: {
  parentSessionId: string;
  parentRunId: string;
  id?: string;
  task?: string;
  message: string;
  criteria?: string;
  sources?: SubagentSource[];
  delegationKey?: string;
}): Promise<string> {
  const client = await getPool().connect();
  const id = input.id ?? newSessionId();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('subagent-dispatch'))",
    );
    if (input.delegationKey) {
      const duplicate = await client.query<{ subagent_id: string }>(
        "SELECT subagent_id FROM agent_run WHERE delegation_key=$1",
        [input.delegationKey],
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return duplicate.rows[0].subagent_id;
      }
    }
    const parent = await client.query<{
      user_id: string;
      production_id: string | null;
      budget: string;
    }>(
      `SELECT s.user_id, s.production_id, COALESCE(r.budget_run_id,r.id) AS budget
       FROM agent_run r JOIN agent_session s ON s.id=r.session_id
       WHERE r.id=$1 AND r.session_id=$2 AND r.status IN ${ACTIVE}
         AND r.subagent_id IS NULL AND r.schedule_id IS NULL`,
      [input.parentRunId, input.parentSessionId],
    );
    const owner = parent.rows[0];
    if (!owner) throw new Error("只有活动中的交互主 Agent 可以委托子任务");
    const queued = await client.query<{ n: string }>(
      `SELECT count(*)::text n FROM agent_run r JOIN agent_subagent c ON c.id=r.subagent_id
       WHERE c.id IN(SELECT id FROM agent_session WHERE parent_session_id=$1) AND r.status='queued'`,
      [input.parentSessionId],
    );
    if (Number(queued.rows[0].n) >= SUBAGENT_QUEUE_DEPTH)
      throw new Error("子任务排队已满，请等待已有任务结束");
    if (input.id) {
      const child = await client.query<{ sources: SubagentSource[] }>(
        `SELECT sources FROM agent_subagent WHERE id=$1 AND id IN(SELECT id FROM agent_session WHERE parent_session_id=$2) AND NOT stopped FOR UPDATE`,
        [id, input.parentSessionId],
      );
      if (!child.rowCount)
        throw new Error("子 Agent 不存在、已停止或不属于当前会话");
      const combined = [...child.rows[0].sources, ...(input.sources ?? [])];
      if (
        combined.length > 30 ||
        combined.reduce((n, s) => n + s.content.length, 0) > 300_000 ||
        new Set(combined.map((s) => s.id)).size !== combined.length
      ) {
        throw new Error("交接材料超过上限或材料 id 重复，请缩小批次");
      }
      await client.query(
        `UPDATE agent_subagent SET sources=sources || $2::jsonb, context_request=NULL WHERE id=$1`,
        [id, JSON.stringify(input.sources ?? [])],
      );
    } else {
      await client.query(
        `INSERT INTO agent_session(id,user_id,production_id,title,parent_session_id) VALUES($1,$2,$3,$4,$5)`,
        [
          id,
          owner.user_id,
          owner.production_id,
          input.task,
          input.parentSessionId,
        ],
      );
      await client.query(
        `INSERT INTO agent_subagent(id,task,completion_criteria,sources)
         VALUES($1,$2,$3,$4::jsonb)`,
        [
          id,
          input.task,
          input.criteria ?? "",
          JSON.stringify(input.sources ?? []),
        ],
      );
    }
    await client.query(
      `INSERT INTO agent_run(id,session_id,subagent_id,budget_run_id,status,model,initial_message,delegation_key)
       VALUES($1,$2,$2,$3,'queued',$4,$5,$6)`,
      [
        newRunId(),
        id,
        owner.budget,
        CHAT_MODEL.id,
        input.message,
        input.delegationKey ?? null,
      ],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 全局短事务认领；锁只覆盖名额计算和状态更新，不覆盖模型执行。 */
export async function claimSubagents(): Promise<SubagentJob[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('subagent-dispatch'))",
    );
    const claimed = await client.query<SubagentJob>(
      `SELECT r.*,s.parent_session_id,c.task,c.completion_criteria,c.context_request,s.user_id,s.production_id
       FROM agent_run r JOIN agent_subagent c ON c.id=r.subagent_id
       JOIN agent_session s ON s.id=c.id JOIN agent_run budget ON budget.id=r.budget_run_id
       WHERE r.status='queued' AND NOT c.stopped AND budget.task_credits <= $1
       ORDER BY r.started_at,r.id FOR UPDATE OF r`,
      [RUN_CREDIT_HARD_CAP],
    );
    const result: SubagentJob[] = [];
    for (const row of claimed.rows) {
      const counts = await client.query<{
        session: string;
        user: string;
        same: string;
      }>(
        `SELECT count(*) FILTER(WHERE c.id IN(SELECT id FROM agent_session WHERE parent_session_id=$1))::text AS session,
           count(*) FILTER(WHERE s.user_id=$2)::text AS "user",
           count(*) FILTER(WHERE r.session_id=$3)::text AS same
         FROM agent_run r JOIN agent_subagent c ON c.id=r.subagent_id
         JOIN agent_session s ON s.id=r.session_id WHERE r.status IN ${ACTIVE}`,
        [row.parent_session_id, row.user_id, row.session_id],
      );
      const count = counts.rows[0];
      if (
        Number(count.session) >= SUBAGENT_CONCURRENCY ||
        Number(count.user) >= SUBAGENT_USER_CONCURRENCY ||
        Number(count.same)
      )
        continue;
      const update = await client.query<{ execution_started_at: Date }>(
        `UPDATE agent_run SET status='running',owner=$2,heartbeat_at=now(),execution_started_at=now()
         WHERE id=$1 AND status='queued' RETURNING execution_started_at`,
        [row.id, RUNNER_OWNER],
      );
      if (update.rowCount) {
        await client.query(
          "UPDATE agent_subagent SET context_request=NULL WHERE id=$1",
          [row.subagent_id],
        );
        result.push({
          ...row,
          context_request: null,
          execution_started_at: update.rows[0].execution_started_at,
        });
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listSubagents(
  parentSessionId: string,
): Promise<SubagentView[]> {
  const result = await getPool().query<SubagentView>(
    `SELECT c.id,c.task,CASE WHEN c.stopped THEN 'stopped' WHEN c.context_request IS NOT NULL THEN 'awaiting_context'
       ELSE COALESCE(r.status,'completed') END AS status,r.result,r.error,c.context_request AS "contextRequest",
       r.id AS "runId",(SELECT e.payload->'message'->>'toolName' FROM agent_session_entry e
         WHERE e.session_id=c.id AND e.type='message' ORDER BY e.seq DESC LIMIT 1) AS progress
     FROM agent_subagent c LEFT JOIN LATERAL(SELECT * FROM agent_run WHERE subagent_id=c.id
       ORDER BY started_at DESC,id DESC LIMIT 1) r ON true
     WHERE c.id IN(SELECT id FROM agent_session WHERE parent_session_id=$1) ORDER BY c.created_at,c.id`,
    [parentSessionId],
  );
  return result.rows;
}

export async function ownSubagent(
  parentSessionId: string,
  id: string,
): Promise<SubagentView> {
  const row = (await listSubagents(parentSessionId)).find(
    (child) => child.id === id,
  );
  if (!row)
    throw Object.assign(new Error("子 Agent 不属于当前会话"), { status: 403 });
  return row;
}

export async function subagentSources(id: string): Promise<SubagentSource[]> {
  const result = await getPool().query<{ sources: SubagentSource[] }>(
    "SELECT sources FROM agent_subagent WHERE id=$1",
    [id],
  );
  if (!result.rows[0]) throw new Error("子会话不存在");
  return result.rows[0].sources;
}

export async function pendingChildJobs(): Promise<SubagentJob[]> {
  const result = await getPool().query<SubagentJob>(
    `SELECT r.*,s.parent_session_id,c.task,c.completion_criteria,c.context_request,s.user_id,s.production_id
     FROM agent_run r JOIN agent_subagent c ON c.id=r.subagent_id JOIN agent_session s ON s.id=c.id
     WHERE r.status IN ${ACTIVE} AND NOT c.stopped AND r.owner=$1`,
    [RUNNER_OWNER],
  );
  return result.rows;
}

export async function claimChildOrphans(
  orphanAfterMs: number,
): Promise<SubagentJob[]> {
  await getPool().query(
    `UPDATE agent_run SET owner=$1,heartbeat_at=now() WHERE subagent_id IS NOT NULL
      AND status IN ${ACTIVE} AND (heartbeat_at IS NULL OR heartbeat_at<now()-($2::int*interval '1 millisecond'))
`,
    [RUNNER_OWNER, orphanAfterMs],
  );
  return pendingChildJobs();
}

/** 所有模型调用共用根任务预算；数据库原子累加，避免并发子任务各烧一份硬顶。 */
export async function addTaskCost(
  runId: string,
  usd: number,
): Promise<boolean> {
  const result = await getPool().query<{ task_credits: string }>(
    `UPDATE agent_run SET task_credits=task_credits+$2 WHERE id=(
       SELECT COALESCE(budget_run_id,id) FROM agent_run WHERE id=$1) RETURNING task_credits`,
    [runId, creditsFromUsd(usd)],
  );
  return (
    !!result.rowCount &&
    Number(result.rows[0].task_credits) <= RUN_CREDIT_HARD_CAP
  );
}

export async function finishSubagent(
  job: SubagentJob,
  outcome: {
    status: string;
    result: string;
    error: string | null;
    contextRequest: string | null;
  },
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('subagent-dispatch'))",
    );
    const updated = await client.query(
      `UPDATE agent_run SET status=$2,result=$3,error=$4,ended_at=now(),
      heartbeat_at=now() WHERE id=$1 AND owner=$5 AND status IN ${ACTIVE}`,
      [job.id, outcome.status, outcome.result, outcome.error, RUNNER_OWNER],
    );
    if (updated.rowCount)
      await client.query(
        `UPDATE agent_subagent SET context_request=$2 WHERE id=$1 AND NOT stopped
       AND NOT EXISTS(SELECT 1 FROM agent_run WHERE subagent_id=$1 AND status='queued')`,
        [job.subagent_id, outcome.contextRequest],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 终态 outbox：完成落行后崩溃也可补交；同一根任务所有子轮次结束后合并通知。 */
export async function deliverSubagentNotifications(): Promise<string[]> {
  const client = await getPool().connect();
  const sessions = new Set<string>();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('subagent-dispatch'))",
    );
    const completed = await client.query<{
      id: string;
      subagent_id: string;
      budget_run_id: string;
      parent_session_id: string;
      status: string;
      result: string | null;
      error: string | null;
      context_request: string | null;
    }>(`SELECT r.*,s.parent_session_id,CASE WHEN NOT EXISTS(
         SELECT 1 FROM agent_run newer WHERE newer.subagent_id=r.subagent_id
         AND (newer.started_at,newer.id)>(r.started_at,r.id)) THEN c.context_request END AS context_request FROM agent_run r JOIN agent_subagent c ON c.id=r.subagent_id JOIN agent_session s ON s.id=c.id
       WHERE r.status IN ('completed','failed','aborted','interrupted') AND NOT r.notification_delivered AND NOT c.stopped
       ORDER BY r.started_at,r.id FOR UPDATE OF r`);
    const groups = new Map<string, typeof completed.rows>();
    for (const row of completed.rows) {
      const key = row.context_request ? row.id : row.budget_run_id;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      const row = rows[0];
      if (!row.context_request) {
        const pending = await client.query(
          `SELECT 1 FROM agent_run WHERE budget_run_id=$1
          AND subagent_id IS NOT NULL AND status IN ('queued','running','compacting','awaiting_approval','awaiting_answer') LIMIT 1`,
          [row.budget_run_id],
        );
        if (pending.rowCount) continue;
      }
      const eventId = `ain_subagent_${rows.at(-1)!.id}`;
      const payload = rows.map((r) => ({
        subagentId: r.subagent_id,
        runId: r.id,
        budgetRunId: r.budget_run_id,
        status: r.context_request ? "awaiting_context" : r.status,
        contextRequest: r.context_request,
        summary: (r.context_request || r.result || r.error || "无结果").slice(
          0,
          800,
        ),
      }));
      await client.query(
        `INSERT INTO agent_session_inbox(id,session_id,message,kind,payload)
        SELECT $1,$2,'','subagent_event',$3::jsonb WHERE NOT EXISTS(
          SELECT 1 FROM agent_session_entry WHERE session_id=$2 AND entry_id=$1)
        ON CONFLICT(id) DO NOTHING`,
        [eventId, row.parent_session_id, JSON.stringify(payload)],
      );
      await client.query(
        "UPDATE agent_run SET notification_delivered=true WHERE id=ANY($1::text[])",
        [rows.map((r) => r.id)],
      );
      sessions.add(row.parent_session_id);
    }
    await client.query("COMMIT");
    return [...sessions];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelSubagents(
  parentSessionId: string,
  id?: string,
): Promise<string[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('subagent-dispatch'))",
    );
    const children = await client.query<{ id: string }>(
      `UPDATE agent_subagent SET stopped=true,context_request=NULL
      WHERE id IN(SELECT id FROM agent_session WHERE parent_session_id=$1) AND ($2::text IS NULL OR id=$2) RETURNING id`,
      [parentSessionId, id ?? null],
    );
    const ids = children.rows.map((r) => r.id);
    await client.query(
      `UPDATE agent_run SET status='aborted',ended_at=now(),error='用户停止',notification_delivered=true
      WHERE subagent_id=ANY($1::text[]) AND status IN ('queued','running','compacting','awaiting_approval','awaiting_answer')`,
      [ids],
    );
    // 同批其他子任务的通知继续保留，仅移除被停止的条目。
    await client.query(
      `UPDATE agent_session_inbox SET payload=COALESCE((
        SELECT jsonb_agg(e) FROM jsonb_array_elements(payload) e
        WHERE NOT (e->>'subagentId'=ANY($2::text[]))), '[]'::jsonb)
       WHERE session_id=$1 AND kind='subagent_event'`,
      [parentSessionId, ids],
    );
    await client.query(
      "DELETE FROM agent_session_inbox WHERE session_id=$1 AND kind='subagent_event' AND payload='[]'::jsonb",
      [parentSessionId],
    );
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function subagentHeartbeat(runId: string): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE agent_run SET heartbeat_at=now() WHERE id=$1 AND owner=$2",
    [runId, RUNNER_OWNER],
  );
  return result.rowCount === 1;
}

export async function childTranscript(
  id: string,
  cursor: number,
  limit: number,
) {
  return (
    await getPool().query<{ seq: number; payload: Record<string, unknown> }>(
      "SELECT seq,payload FROM agent_session_entry WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
      [id, cursor, limit + 1],
    )
  ).rows;
}

export async function setChildContextRequest(
  id: string,
  request: string,
): Promise<void> {
  await getPool().query(
    `UPDATE agent_subagent SET context_request=$2 WHERE id=$1 AND NOT stopped
       AND NOT EXISTS(SELECT 1 FROM agent_run WHERE subagent_id=$1 AND status='queued')`,
    [id, request],
  );
}

export async function signalSubagentState(
  parentSessionId: string,
): Promise<void> {
  // NOTIFY 只负责唤醒；状态事实仍由查询接口读取，不占主会话的 transcript。
  await getPool().query("SELECT pg_notify('agent_events',$1||':0')", [
    parentSessionId,
  ]);
}

export async function setChildRunStatus(
  runId: string,
  status: "running" | "compacting",
): Promise<void> {
  await getPool().query(
    "UPDATE agent_run SET status=$2 WHERE id=$1 AND owner=$3",
    [runId, status, RUNNER_OWNER],
  );
}
