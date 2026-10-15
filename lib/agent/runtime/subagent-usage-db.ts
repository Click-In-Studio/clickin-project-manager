import { getPool } from "@/lib/pg";
import { creditsFromUsd } from "@/lib/account/plan";
import {
  getQuotaStatus,
  paidFromOf,
  quotaOwnerOf,
  chargeExtraCredits,
} from "@/lib/agent/ai-quota";
import { resolveModel } from "./config";
import { usdOfUsage } from "./billing";
import type { SubagentJob } from "./subagent-db";
import type { AssistantMessage } from "../../../vendor/openclaw/packages/llm-core/src/types";

/** 同一条持久消息只结算一次；用量与额外额度在同一事务落地；任务预算已在请求边界结算。 */
export async function recordChildUsage(
  job: SubagentJob,
  entryId: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    usd: number;
    compaction?: boolean;
    modelId?: string;
  },
): Promise<void> {
  const source = await getPool().query<{
    paid_from: import("@/lib/agent/ai-quota").PaidFrom | null;
  }>("SELECT paid_from FROM agent_run WHERE id=$1", [job.budget_run_id]);
  const paid =
    source.rows[0]?.paid_from ??
    paidFromOf(
      await getQuotaStatus({
        userId: job.user_id,
        productionId: job.production_id,
      }),
    );
  const owner = await quotaOwnerOf(job.user_id, job.production_id);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      "INSERT INTO agent_subagent_usage(id,run_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id",
      [entryId, job.id],
    );
    const credits = creditsFromUsd(usage.usd);
    if (inserted.rowCount) {
      const rows: Array<[string, number, number]> = usage.compaction
        ? [["chat_compaction", usage.input, credits]]
        : [
            ["chat_input", usage.input, credits],
            ["chat_output", usage.output, 0],
            ["chat_cache_read", usage.cacheRead, 0],
          ];
      for (const [kind, tokens, billed] of rows) {
        if (!tokens && !billed) continue;
        await client.query(
          `INSERT INTO ai_usage(user_id,production_id,kind,model,tokens,billed_credits,paid_from)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            job.user_id,
            job.production_id,
            kind,
            usage.modelId ?? job.model,
            tokens,
            billed,
            paid,
          ],
        );
      }
      if (paid === "extra") await chargeExtraCredits(owner, credits, client);
      if (!usage.compaction)
        await client.query(
          `UPDATE agent_run SET input_tokens=input_tokens+$2,
        output_tokens=output_tokens+$3,cache_read_tokens=cache_read_tokens+$4 WHERE id=$1`,
          [job.id, usage.input, usage.output, usage.cacheRead],
        );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 恢复时从原始消息补结算；不依赖已被压缩的模型上下文。 */
export async function checkpointChildUsage(job: SubagentJob): Promise<void> {
  const entries = await getPool().query<{
    entry_id: string;
    message: AssistantMessage;
  }>(
    `SELECT e.entry_id,e.payload->'message' AS message
    FROM agent_session_entry e WHERE e.session_id=$1 AND e.seq>(SELECT seq FROM agent_session_entry WHERE session_id=$1 AND entry_id=$2)
    AND e.seq<COALESCE((SELECT min(n.seq) FROM agent_session_entry n WHERE n.session_id=$1 AND n.seq>(SELECT seq FROM agent_session_entry WHERE session_id=$1 AND entry_id=$2) AND n.payload->'message'->>'role'='user'),2147483647)
    AND e.payload->'message'->>'role'='assistant' AND NOT EXISTS(SELECT 1 FROM agent_subagent_usage u WHERE u.id=e.entry_id) ORDER BY e.seq`,
    [job.session_id, `ain_child_${job.id}`],
  );
  for (const { entry_id, message } of entries.rows) {
    if (!message.usage) continue;
    const u = message.usage;
    await recordChildUsage(job, entry_id, {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      usd: usdOfUsage(u, resolveModel(job.model_selection.modelKey)),
    });
  }
}

export async function recoverChildUsage(): Promise<void> {
  const jobs = await getPool()
    .query<SubagentJob>(`SELECT r.*,s.parent_session_id,s.user_id,s.production_id FROM agent_run r
    JOIN agent_session s ON s.id=r.session_id WHERE r.subagent_id IS NOT NULL
    AND r.status IN ('completed','failed','aborted','interrupted') AND EXISTS(
      SELECT 1 FROM agent_session_entry e WHERE e.session_id=r.session_id
      AND e.payload->'message'->>'role'='assistant' AND NOT EXISTS(SELECT 1 FROM agent_subagent_usage u WHERE u.id=e.entry_id))`);
  for (const job of jobs.rows) await checkpointChildUsage(job);
}
