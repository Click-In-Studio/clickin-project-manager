import { memoryTransaction, MemoryAccessError, MemoryConflictError } from "./memory-access-db";
import { MEMORY_GROUP_BRIEF_MAX } from "./memory-types";
import type { GroupRow, SummaryProgress } from "./memory-group-db";

export async function pendingMemorySummaries(userId: string, productionId: string | null, groupId?: string) {
  return memoryTransaction(userId, productionId, async (c, s) =>
    (await c.query<GroupRow>(
      `SELECT * FROM agent_memory_group WHERE scope_id=$1 AND context_chars>$2
       AND (summary IS NULL OR summary_revision IS DISTINCT FROM revision)
       AND ($3::text IS NULL OR id=$3) ORDER BY id`,
      [s.id, MEMORY_GROUP_BRIEF_MAX, groupId ?? null],
    )).rows,
  );
}

export async function readSummaryProgress(userId: string, productionId: string | null, groupId: string, revision: number) {
  return memoryTransaction(userId, productionId, async (c, s) => {
    const g = (await c.query<GroupRow>("SELECT * FROM agent_memory_group WHERE scope_id=$1 AND id=$2", [s.id, groupId])).rows[0];
    if (!g) throw new MemoryAccessError("记忆组不存在");
    if (Number(g.revision) !== revision) throw new MemoryConflictError("记忆组已变化，请重新读取概览");
    return { complete: g.summary !== null && g.summary_revision === g.revision, progress: g.summary_progress };
  });
}

/** 每页完成就持久化；CAS 防止并发整理把较新的进度覆盖回旧页。 */
export async function saveSummaryProgress(
  userId: string, productionId: string | null, groupId: string, revision: number,
  previous: SummaryProgress | null, next: SummaryProgress,
): Promise<boolean> {
  return memoryTransaction(userId, productionId, async (c, s) =>
    (await c.query(
      `UPDATE agent_memory_group SET summary_progress=$5::jsonb WHERE scope_id=$1 AND id=$2 AND revision=$3
       AND summary_progress IS NOT DISTINCT FROM $4::jsonb AND summary_revision IS DISTINCT FROM revision`,
      [s.id, groupId, revision, previous === null ? null : JSON.stringify(previous), JSON.stringify(next)],
    )).rowCount === 1,
  );
}
