import type { Context } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import type { PoolClient } from "pg";
import { RUNNER_OWNER } from "./config";
import { contextRepeatsWithoutProgress, repeatsWithoutProgress, TASK_COST_LIMIT_CREDITS } from "./cost-budget";

const BUDGET_ERROR = "task-budget-exceeded: 本次任务的剩余预算不足以开始下一次模型请求，已保留完成的操作。请缩小下一批任务后继续。";
async function lockBudget(client: PoolClient, runId: string) {
  const row = (await client.query<{ id: string; task_credits: string; task_budget_credits: string }>(
    `SELECT b.id,b.task_credits,b.task_budget_credits FROM agent_run r
     JOIN agent_run b ON b.id=COALESCE(r.budget_run_id,r.id) WHERE r.id=$1 FOR UPDATE OF b`, [runId],
  )).rows[0];
  if (!row) throw new Error("任务预算不存在");
  return row;
}

/** 根任务行锁让主脑与并发子任务共同预留；同一名额的重试不叠加预留。 */
export async function reserveRequestCost(runId: string, ticketId: string, requestCredits: number, taskCredits: number) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const root = await lockBudget(client, runId);
    const ticket = (await client.query<{ reserved_credits: string }>(
      "SELECT reserved_credits FROM agent_admission WHERE id=$1 AND run_id=$2 AND owner=$3 AND state='active' FOR UPDATE", [ticketId, runId, RUNNER_OWNER],
    )).rows[0];
    if (!ticket) throw new Error("模型请求租约已失效");
    // 崩溃后的旧预留不能静默释放：上游是否扣费未知，保守计入本任务预算。
    if (Number(ticket.reserved_credits)) {
      await client.query("UPDATE agent_run SET task_credits=task_credits+$2 WHERE id=$1", [root.id, ticket.reserved_credits]);
      root.task_credits = String(Number(root.task_credits) + Number(ticket.reserved_credits));
      await client.query("UPDATE agent_admission SET reserved_credits=0 WHERE id=$1", [ticketId]);
    }
    const reserved = Number((await client.query<{ credits: string }>(
      `SELECT COALESCE(sum(a.reserved_credits),0)::text AS credits FROM agent_admission a JOIN agent_run r ON r.id=a.run_id
       WHERE COALESCE(r.budget_run_id,r.id)=$1 AND a.id<>$2`, [root.id, ticketId],
    )).rows[0].credits);
    const budget = Math.min(TASK_COST_LIMIT_CREDITS, Math.max(Number(root.task_budget_credits), taskCredits));
    await client.query("UPDATE agent_run SET task_budget_credits=$2 WHERE id=$1", [root.id, budget]);
    const spent = Number(root.task_credits);
    const allowed = spent + reserved + requestCredits <= budget;
    if (allowed) await client.query("UPDATE agent_admission SET reserved_credits=$2 WHERE id=$1", [ticketId, requestCredits]);
    await client.query("COMMIT");
    if (!allowed) throw new Error(BUDGET_ERROR);
    return { budgetRunId: root.id, budgetCredits: budget, spentCredits: spent, reservedCredits: reserved, requestCredits };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** 结算在向 harness 发送终态之前完成；重复结算不重复累加根预算。 */
export async function settleRequestCost(runId: string, ticketId: string, actualCredits: number): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const root = await lockBudget(client, runId);
    const settled = await client.query(
      `UPDATE agent_admission SET reserved_credits=0,charged_credits=charged_credits+$2
       WHERE id=$1 AND reserved_credits>0 AND owner=$3 AND run_id=$4 RETURNING id`, [ticketId, actualCredits, RUNNER_OWNER, runId],
    );
    if (settled.rowCount) await client.query("UPDATE agent_run SET task_credits=task_credits+$2 WHERE id=$1", [root.id, actualCredits]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** 使用持久调用记录，排水恢复不会清空循环证据；新用户输入重新划分检测范围。 */
export async function assertToolProgress(runId: string, context?: Context): Promise<void> {
  const rows = (await getPool().query<{ progress_key: string }>(
    `SELECT o.progress_key FROM agent_tool_operation o JOIN agent_run r ON r.id=o.run_id
     WHERE o.run_id=$1 AND o.progress_key IS NOT NULL AND o.input_entry_id=(
       SELECT e.entry_id FROM agent_session_entry e WHERE e.session_id=r.session_id AND e.payload->'message'->>'role'='user' ORDER BY e.seq DESC LIMIT 1)
     ORDER BY o.completed_at DESC,o.id DESC LIMIT 12`, [runId],
  )).rows;
  if (repeatsWithoutProgress(rows.reverse().map(row => row.progress_key)) || (context && contextRepeatsWithoutProgress(context.messages))) throw new Error("tool-loop-detected: 助手反复执行相同操作且没有取得新结果，已停止下一次模型请求。已完成的操作已保留。");
}
