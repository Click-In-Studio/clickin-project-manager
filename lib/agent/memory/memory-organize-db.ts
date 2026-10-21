import { memoryTransaction, MemoryConflictError } from "./memory-access-db";
import { memoryEntry, type EntryRow } from "./memory-group-db";
import type { MemoryEntry } from "./memory-types";

export async function readOrganizeCandidates(
  userId: string,
  productionId: string | null,
): Promise<{ revision: number; entries: MemoryEntry[]; checked: string[] }> {
  return memoryTransaction(userId, productionId, async (c, s) => {
    const changed = (
      await c.query<EntryRow>(
        `SELECT * FROM agent_memory_entry WHERE scope_id=$1 AND deleted_at IS NULL
      ORDER BY (organized_revision<>revision) DESC,organization_checked_at NULLS FIRST,id LIMIT 8`,
        [s.id],
      )
    ).rows;
    if (!changed.length)
      return { revision: Number(s.revision), entries: [], checked: [] };
    // 搜索候选仅用于减少整理输入，不是关系裁决；冷条目按checked时间轮转。
    const words = [
      ...new Set(
        changed.flatMap(
          (e) => (e.brief + " " + e.body).match(/[\p{L}\p{N}]{2,12}/gu) ?? [],
        ),
      ),
    ].slice(0, 40);
    const others = (
      await c.query<EntryRow>(
        `SELECT * FROM agent_memory_entry WHERE scope_id=$1 AND deleted_at IS NULL AND NOT(id=ANY($2::text[]))
      ORDER BY (SELECT count(*) FROM unnest($3::text[]) t WHERE strpos(brief||' '||body,t)>0) DESC,updated_at DESC,id LIMIT 8`,
        [s.id, changed.map((e) => e.id), words],
      )
    ).rows;
    return {
      revision: Number(s.revision),
      entries: [...changed, ...others].map(memoryEntry),
      checked: changed.map((e) => e.id),
    };
  });
}
export async function markOrganized(
  userId: string,
  productionId: string | null,
  checked: MemoryEntry[],
): Promise<void> {
  await memoryTransaction(userId, productionId, async (c, s) => {
    for (const entry of checked) {
      const result = await c.query(
        "UPDATE agent_memory_entry SET organized_revision=revision,organization_checked_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL",
        [s.id, entry.id, entry.revision],
      );
      if (!result.rowCount) throw new MemoryConflictError("整理输入已变化");
    }
  });
}
