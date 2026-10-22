import { enqueueJob } from "@/lib/job/queue";
import { memoryTransaction } from "./memory-access-db";
import { pendingMemorySummaries } from "./memory-summary-db";

/** 保存路径只等待持久化入队；整理仍先于高水位淘汰执行。 */
export async function enqueueMemoryMaintenance(userId: string, productionId: string | null): Promise<void> {
  const revision = await memoryTransaction(userId, productionId, async (_c, s) => s.revision);
  await enqueueJob({
    kind: "memory_maintenance",
    dedupeKey: `memory_maintenance:${userId}:${productionId ?? ""}:${revision}`,
    payload: { userId, productionId },
    detachedInline: true,
    priority: -1,
  });
}

export async function enqueuePendingSummaries(userId: string, productionId: string | null, groupId?: string): Promise<void> {
  for (const group of await pendingMemorySummaries(userId, productionId, groupId)) {
    const progress = group.summary_progress;
    await enqueueJob({
      kind: "memory_summary",
      dedupeKey: `memory_summary:${group.id}:${group.revision}:${progress?.offset ?? 0}:${progress?.relationAfter ?? ""}`,
      payload: { userId, productionId, groupId: group.id, revision: Number(group.revision) },
      detachedInline: true,
      priority: -1,
    });
  }
}
