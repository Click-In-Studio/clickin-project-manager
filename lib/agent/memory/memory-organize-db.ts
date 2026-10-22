import { memoryTransaction, MemoryConflictError } from "./memory-access-db";
import { memoryEntry, type EntryRow } from "./memory-group-db";
import { bigramTokens } from "./index-db";
import { embeddingModel } from "./embedding";
import type { MemoryEntry } from "./memory-types";

/** 当前 text-embedding-v4 构造样本：同义约0.77—0.81，无关约0.25—0.37。
 * 仅作为候选下限，不把语义相近直接认定为重复或冲突。 */
export const ORGANIZE_VECTOR_MIN = 0.5;

export async function readOrganizeSeeds(userId: string, productionId: string | null): Promise<MemoryEntry[]> {
  return memoryTransaction(userId, productionId, async (c, s) => {
    const changed = (
      await c.query<EntryRow>(
        `SELECT * FROM agent_memory_entry WHERE scope_id=$1 AND deleted_at IS NULL
      AND (organized_revision<>revision OR organization_checked_at IS NULL OR organization_checked_at<now()-interval '1 day')
      ORDER BY (organized_revision<>revision) DESC,organization_checked_at NULLS FIRST,id LIMIT 8`,
        [s.id],
      )
    ).rows;
    return changed.map(memoryEntry);
  });
}

export async function readOrganizeCandidates(
  userId: string,
  productionId: string | null,
  seeds?: MemoryEntry[],
): Promise<{ revision: number; entries: MemoryEntry[]; checked: string[] }> {
  seeds ??= await readOrganizeSeeds(userId, productionId);
  const selected = seeds;
  return memoryTransaction(userId, productionId, async (c, s) => {
    const changed = (await c.query<EntryRow>(
      "SELECT * FROM agent_memory_entry WHERE scope_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id",
      [s.id, selected.map(e => e.id)],
    )).rows;
    if (!changed.length)
      return { revision: Number(s.revision), entries: [], checked: [] };
    // 每个待审条目各取相关候选，避免八条新记忆共享一个候选配额。
    // 每条至多四个相关候选，不用零分项凑数；复用当前向量和中文 bigram。
    // 未变化条目每天最多复查一次，条目有效期不受影响。
    const entries = new Map(changed.map(e => [e.id, e]));
    for (const seed of changed) {
      const words = [...new Set(bigramTokens(seed.brief + " " + seed.body))];
      const related = (await c.query<EntryRow>(
        `WITH scored AS (
         SELECT e.*,
           CASE WHEN seed.embedding IS NOT NULL AND seed.embedding_revision=seed.revision AND seed.embedding_model=$5
             AND e.embedding IS NOT NULL AND e.embedding_revision=e.revision AND e.embedding_model=$5
             THEN 1-(e.embedding<=>seed.embedding) ELSE 0 END AS vector_score,
           COALESCE((SELECT avg((strpos(lower(e.brief||' '||e.body),t)>0)::int) FROM unnest($4::text[]) t),0) AS lexical_score
         FROM agent_memory_entry e JOIN agent_memory_entry seed ON seed.id=$2 AND seed.scope_id=e.scope_id
         WHERE e.scope_id=$1 AND e.deleted_at IS NULL AND NOT(e.id=ANY($3::text[])))
         SELECT * FROM scored WHERE lexical_score>0 OR vector_score>$6
         ORDER BY GREATEST(vector_score,lexical_score) DESC,updated_at DESC,id LIMIT 4`,
        [s.id, seed.id, changed.map(e => e.id), words, embeddingModel(), ORGANIZE_VECTOR_MIN],
      )).rows;
      for (const entry of related) entries.set(entry.id, entry);
    }
    return {
      revision: Number(s.revision),
      entries: [...entries.values()].map(memoryEntry),
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
