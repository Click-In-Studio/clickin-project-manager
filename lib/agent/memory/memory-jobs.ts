import { enqueueJob } from "@/lib/job/queue";
import { scheduleMemoryMaintenance } from "./memory-maintenance-db";
import { pendingMemorySummaries } from "./memory-summary-db";

/** 同步回落缓存，只把嵌入、整理及摘要留给后台。 */
export async function enqueueMemoryMaintenance(userId: string, productionId: string | null, touchOnly = false): Promise<void> {
  await scheduleMemoryMaintenance(userId, productionId, touchOnly);
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
