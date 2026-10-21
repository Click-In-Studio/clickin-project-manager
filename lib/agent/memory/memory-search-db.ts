import {
  embedDocuments,
  embedQuery,
  embeddingModel,
  embeddingMode,
} from "./embedding";
import { bigramTokens } from "./index-db";
import { memoryTransaction } from "./memory-access-db";
import { readGroupsInTx } from "./memory-group-db";
import type { MemoryGroup } from "./memory-types";

/** 向量是可重建派生数据；修订不一致的旧向量永不参与搜索。 */
export async function indexMemoryEntries(
  userId: string,
  productionId: string | null,
): Promise<void> {
  if (embeddingMode() === "none") return;
  const rows = await memoryTransaction(
    userId,
    productionId,
    async (c, s) =>
      (
        await c.query<{
          id: string;
          brief: string;
          body: string;
          revision: string;
        }>(
          "SELECT id,brief,body,revision FROM agent_memory_entry WHERE scope_id=$1 AND deleted_at IS NULL AND (embedding IS NULL OR embedding_revision<>revision OR embedding_model IS DISTINCT FROM $2) ORDER BY updated_at,id LIMIT 10",
          [s.id, embeddingModel()],
        )
      ).rows,
  );
  if (!rows.length) return;
  const result = await embedDocuments(rows.map((e) => `${e.brief}\n${e.body}`));
  await memoryTransaction(userId, productionId, async (c, s) => {
    for (let i = 0; i < rows.length; i++)
      await c.query(
        "UPDATE agent_memory_entry SET embedding=$4::vector,embedding_model=$5,embedding_revision=revision WHERE scope_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL",
        [
          s.id,
          rows[i].id,
          rows[i].revision,
          JSON.stringify(result.embeddings[i]),
          embeddingModel(),
        ],
      );
  });
}
export async function searchMemoryGroups(
  userId: string,
  productionId: string | null,
  query: string,
  limit = 6,
): Promise<MemoryGroup[]> {
  if (!query.trim()) return [];
  const vector =
    embeddingMode() === "none"
      ? null
      : JSON.stringify((await embedQuery(query)).embedding);
  const tokens = [...new Set(bigramTokens(query))];
  return memoryTransaction(userId, productionId, async (c, s) => {
    const ranked = await c.query<{ group_id: string; score: number }>(
      `WITH scored AS (
      SELECT e.group_id,GREATEST(
        CASE WHEN $3::vector IS NOT NULL AND e.embedding_revision=e.revision AND e.embedding_model=$5 THEN 1-(e.embedding<=>$3::vector) ELSE 0 END,
        COALESCE((SELECT avg((strpos(lower(e.brief||' '||e.body),t)>0)::int) FROM unnest($4::text[]) t),0)) AS score
      FROM agent_memory_entry e WHERE e.scope_id=$1 AND e.deleted_at IS NULL)
      SELECT group_id,max(score) AS score FROM scored GROUP BY group_id HAVING max(score)>=0.35 ORDER BY score DESC,group_id LIMIT $2`,
      [
        s.id,
        Math.min(20, Math.max(1, limit)),
        vector,
        tokens,
        embeddingModel(),
      ],
    );
    const groups = await readGroupsInTx(
      c,
      s.id,
      ranked.rows.map((r) => r.group_id),
    );
    const byId = new Map(groups.map((g) => [g.id, g]));
    return ranked.rows.flatMap((r) =>
      byId.has(r.group_id) ? [byId.get(r.group_id)!] : [],
    );
  });
}
export async function cachePressure(
  userId: string,
  productionId: string | null,
): Promise<number> {
  return memoryTransaction(userId, productionId, async (c, s) =>
    Number(
      (
        await c.query<{ n: string }>(
          "SELECT COALESCE(sum(member_count),0) n FROM agent_memory_group WHERE scope_id=$1 AND in_cache",
          [s.id],
        )
      ).rows[0].n,
    ),
  );
}
