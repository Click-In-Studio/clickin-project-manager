import { dispatchQueuedJob, newJobId } from "@/lib/job/queue";
import { memoryTransaction } from "./memory-access-db";
import { evictInTx } from "./memory-group-db";

/** 用户锁串行化入队、合并信号与任务开工；缓存回落不依赖 worker 存活。 */
export async function scheduleMemoryMaintenance(userId: string, productionId: string | null, touchOnly: boolean): Promise<void> {
  const id = await memoryTransaction(userId, productionId, async (c, s) => {
    const forceOrganize = (await evictInTx(c, s.id)).length > 0;
    if (touchOnly && !forceOrganize) return null;
    const payload = { userId, productionId, forceOrganize };
    const result = await c.query<{ id: string }>(
      `INSERT INTO job(id,kind,payload,dedupe_key,priority,run_after)
       VALUES($1,'memory_maintenance',$2::jsonb,$3,-1,now()+interval '1 second')
       ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running')
       DO UPDATE SET payload=job.payload || jsonb_build_object('forceOrganize',
         COALESCE((job.payload->>'forceOrganize')::boolean,false) OR $4)
       RETURNING id`,
      [newJobId(), JSON.stringify(payload), `memory_maintenance:${s.id}`, forceOrganize],
    );
    return result.rows[0].id;
  });
  if (id) await dispatchQueuedJob(id);
}

/** 开工前读合并后的最新信号，并让执行期间的新写入获得一个后续任务。 */
export async function beginMemoryMaintenance(userId: string, productionId: string | null, jobId: string): Promise<boolean> {
  return memoryTransaction(userId, productionId, async (c) => {
    const result = await c.query<{ payload: { forceOrganize?: boolean } }>(
      `UPDATE job SET dedupe_key=NULL WHERE id=$1 AND kind='memory_maintenance'
       AND payload->>'userId'=$2 AND payload->>'productionId' IS NOT DISTINCT FROM $3
       RETURNING payload`,
      [jobId, userId, productionId],
    );
    return result.rows[0]?.payload.forceOrganize === true;
  });
}
