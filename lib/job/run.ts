// 任务执行（worker 主循环与 inline 形态共用）：认领行 → handler → 终局落库 → 唤醒挂着的 agent 会话。

import { claimJobById, completeJob, failJob, getJob, TerminalJobError, type JobRow } from "./queue";
import { getJobHandlerDef } from "./handlers";

export async function executeClaimedJob(job: JobRow, owner: string): Promise<void> {
  const def = getJobHandlerDef(job.kind);
  try {
    if (!def) throw new TerminalJobError(`未知任务类型：${job.kind}`);
    const result = await def.run(job.payload, job);
    await completeJob(job.id, owner, result ?? null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failJob(job.id, owner, msg, { terminal: err instanceof TerminalJobError });
  }
  await maybeSteer(job.id);
}

/**
 * 任务终局后唤醒等它的 agent 会话（双模式的后台半边）。
 * notifySessionId 不在 enqueue 时写：等待方超时转后台的那一刻才补进 payload
 * （lib/job/queue.ts requestJobSteer）——这里读**最新**行而不是认领时的内存对象，
 * 正是为了接住"超时与完成擦肩"的竞态；快路径（等待内完成）不会留下这个字段，不扰模型。
 */
async function maybeSteer(jobId: string): Promise<void> {
  try {
    const fresh = await getJob(jobId);
    if (!fresh || (fresh.status !== "done" && fresh.status !== "failed")) return;
    const sessionId = typeof fresh.payload.notifySessionId === "string" ? fresh.payload.notifySessionId : null;
    if (!sessionId) return;
    const def = getJobHandlerDef(fresh.kind);
    if (!def?.steerMessage) return;
    const { steerRun } = await import("@/lib/agent-runtime/client");
    await steerRun(sessionId, def.steerMessage(fresh, fresh.status === "done"));
  } catch (err) {
    console.error(`[job] steer for ${jobId} failed:`, err);
  }
}

const INLINE_OWNER = `inline:${process.pid}`;

/** 无 worker 形态：enqueue 原地执行（dev / 测试 / 未配 JOB_WORKER 的部署）。 */
export async function executeJobInline(id: string): Promise<void> {
  const job = await claimJobById(id, INLINE_OWNER);
  if (!job) return; // 已被别人认领/执行
  await executeClaimedJob(job, INLINE_OWNER);
}
