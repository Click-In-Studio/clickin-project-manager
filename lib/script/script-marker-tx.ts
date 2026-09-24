import type { PoolClient } from "pg";
import type { Block, BlockType, MarkerMeta } from "./script-types";
import { DEFAULT_SCRIPT_CONFIG } from "./script-types";
import { normalizeScriptMarkerInvariants, sameMarkerStructure } from "./script-marker-domain";
import { genBlockId, genSnapshotId, isChapterSceneMarkerType } from "./script-row-model";
import { ensureSceneAnchorsInTx, insertSnapshotRowsInTx, snapshotRowFromBlock, type SnapshotRow } from "./script-row-tx";
import { keyBetween } from "../lex-order";

// 标记结构事务 helper（#486 从 lib/db.ts 搬出）：在写侧事务内维护「标记 ↔ 场次 ↔ 归属」
// 不变量——scene_version 排序归一、marker_structure_revision 递增、排练标记归属回填、
// 从标记同步 scene_version。只被 flush / import / patch 三条写路径在事务内调用，
// 自己不开事务、不拿 pool。SQL 片段见 script-marker-sql，纯领域判定见 script-marker-domain。
// 三条写路径的收尾一律走 finalizeMarkerInvariantsInTx（#635），不要各自拼归一化序列。

export type FinalizeMarkerScope =
  // 整版重算：不知道动了哪些块（批量写 / 导入）。传写前的标记结构，收尾比对决定是否 bump。
  | { mode: "full"; previousMarkerStructure: Block[] }
  // 局部：patch 路径已在内存里算出受影响的块 / 场次标记与结构是否变化
  | {
      mode: "scoped";
      affectedBlockIds: string[];
      affectedSceneMarkerIds: string[];
      deletedSceneMarkerIds: string[];
      markerStructureChanged: boolean;
    };

/**
 * 写侧事务的统一收尾：（整版模式先跑域模型的结构修复）→ 从标记同步 scene_version → 归属回填
 * → 结构变了就 bump revision。
 * 必须先场次后归属：场次同步顺手给每个 chapter / scene 标记立 scene identity 行，归属
 * 归一化随后把标记的 script.scene_id 指向自己——FK 锚不先立就撞 script_scene_id_fkey
 * （patch 路径插标记块时 sceneId 常为 null）。返回结构是否变化，调用方据此决定要不要
 * 写派生配置。
 */
export async function finalizeMarkerInvariantsInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
  scope: FinalizeMarkerScope,
): Promise<boolean> {
  if (scope.mode === "full") {
    await repairMarkerStructureInTx(client, productionId, versionId);
    await syncSceneVersionsFromMarkersInTx(client, productionId, versionId);
    await normalizeRehearsalMarkOwnershipInTx(client, versionId);
    const finalMarkerStructure = await markerStructureBlocksInTx(client, versionId);
    const changed = !sameMarkerStructure(scope.previousMarkerStructure, finalMarkerStructure);
    if (changed) await bumpMarkerStructureRevisionInTx(client, versionId);
    return changed;
  }
  await syncSceneVersionsFromMarkersInTx(
    client, productionId, versionId, scope.affectedSceneMarkerIds, scope.deletedSceneMarkerIds,
  );
  if (scope.affectedBlockIds.length > 0) {
    await normalizeRehearsalMarkOwnershipInTx(client, versionId, scope.affectedBlockIds);
  }
  if (scope.markerStructureChanged) await bumpMarkerStructureRevisionInTx(client, versionId);
  return scope.markerStructureChanged;
}

/**
 * 整版跑域模型的标记结构修复（#637）：读全序列 → normalizeScriptMarkerInvariants 全量模式 →
 * 把模型补出来的块插进库（首块开场章、章内正文前的首场、排练标记补位、标记后的占位正文块）。
 * 「什么算正文块」「哪个标记后面要占位」只在 script-marker-domain 判一份：patch 路径在内存里
 * 做同一件事（scoped 模式），整版写（导入 / 批量写）走这里，此前导入自带一份 SQL 扫描已删。
 * 只插行不改既有行——既有行的归属列由随后的 normalizeRehearsalMarkOwnershipInTx 按 SQL 回填，
 * 新插的标记块要先立 scene identity 锚（同 patch 路径）。
 */
async function repairMarkerStructureInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
): Promise<void> {
  const { rows } = await client.query<{
    block_id: string;
    sort_key: string;
    type: BlockType;
    scene_id: string | null;
    rehearsal_mark: string | null;
    owner_marker_id: string | null;
    marker_meta: MarkerMeta | null;
  }>(
    `SELECT sv.block_id, sv.sort_key, s.type::text AS type, s.scene_id, s.rehearsal_mark,
            s.owner_marker_id, s.marker_meta
     FROM script_version sv
     JOIN script s ON s.id = sv.snapshot_id
     WHERE sv.version_id = $1
     ORDER BY sv.sort_key`,
    [versionId],
  );
  const sortKeyById = new Map(rows.map((row) => [row.block_id, row.sort_key]));
  const blocks: Block[] = rows.map((row) => ({
    id: row.block_id,
    type: row.type,
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: row.scene_id,
    rehearsalMark: row.rehearsal_mark,
    ownerMarkerId: row.owner_marker_id,
    markerMeta: { parentMarkerId: row.marker_meta?.parentMarkerId ?? null },
  }));
  const normalized = normalizeScriptMarkerInvariants({
    blocks,
    scenes: [],
    characters: [],
    config: {
      ...DEFAULT_SCRIPT_CONFIG,
      openingChapterMarkerId: blocks.find((block) => block.type === "chapter_marker")?.id ?? null,
    },
  }, genBlockId);

  // 修复只插不删不换序，既有块相对顺序不变：新块的 sort_key 取「前一块（含刚补的）」与
  // 「后面最近一个既有块」之间
  const inserted: SnapshotRow[] = [];
  let previousKey: string | null = null;
  for (let index = 0; index < normalized.blocks.length; index++) {
    const block = normalized.blocks[index];
    const existingKey = sortKeyById.get(block.id);
    if (existingKey !== undefined) {
      previousKey = existingKey;
      continue;
    }
    let nextKey: string | null = null;
    for (let cursor = index + 1; cursor < normalized.blocks.length; cursor++) {
      const key = sortKeyById.get(normalized.blocks[cursor].id);
      if (key !== undefined) {
        nextKey = key;
        break;
      }
    }
    const lexKey = keyBetween(previousKey, nextKey);
    previousKey = lexKey;
    const sceneId = isChapterSceneMarkerType(block.type) ? block.id : null;
    inserted.push(snapshotRowFromBlock(
      block,
      { snapshotId: genSnapshotId(), blockId: block.id, lexKey },
      { sceneId, rehearsalMark: null, forceShowCharacterName: false },
    ));
  }
  if (inserted.length === 0) return;
  await ensureSceneAnchorsInTx(client, productionId, inserted.flatMap((row) => row.sceneId ? [row.sceneId] : []));
  await insertSnapshotRowsInTx(client, productionId, versionId, inserted);
}

async function normalizeSceneOwnershipOrderInTx(client: PoolClient, versionId: string): Promise<void> {
  await client.query(
    `WITH RECURSIVE ranked AS (
       SELECT
         sv.version_id,
         sv.scene_id,
         sv.parent_id,
         sv.sort_order,
         row_number() OVER (
           PARTITION BY sv.version_id
           ORDER BY sv.sort_order, sv.scene_id
         )::bigint AS old_rank
       FROM scene_version sv
       WHERE sv.version_id = $1
     ),
     roots AS (
       SELECT r.*
       FROM ranked r
       WHERE r.parent_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM ranked parent
            WHERE parent.version_id = r.version_id
              AND parent.scene_id = r.parent_id
          )
     ),
     scene_tree AS (
       SELECT
         r.version_id,
         r.scene_id AS root_id,
         r.scene_id,
         r.old_rank AS root_old_rank,
         r.old_rank,
         ARRAY[]::bigint[] AS ownership_path,
         ARRAY[r.scene_id]::text[] AS visited_scene_ids
       FROM roots r

       UNION ALL

       SELECT
         child.version_id,
         tree.root_id,
         child.scene_id,
         tree.root_old_rank,
         child.old_rank,
         tree.ownership_path || child.old_rank,
         tree.visited_scene_ids || child.scene_id
       FROM scene_tree tree
       JOIN ranked child
         ON child.version_id = tree.version_id
        AND child.parent_id = tree.scene_id
       WHERE NOT child.scene_id = ANY(tree.visited_scene_ids)
     ),
     root_positions AS (
       SELECT
         version_id,
         root_id,
         min(old_rank) AS first_owned_rank
       FROM scene_tree
       GROUP BY version_id, root_id
     ),
     ordered AS (
       SELECT
         tree.version_id,
         tree.scene_id,
         row_number() OVER (
           PARTITION BY tree.version_id
           ORDER BY
             root_positions.first_owned_rank,
             tree.root_old_rank,
             tree.ownership_path,
             tree.old_rank,
             tree.scene_id
         )::int - 1 AS new_sort_order
       FROM scene_tree tree
       JOIN root_positions
         ON root_positions.version_id = tree.version_id
        AND root_positions.root_id = tree.root_id
     )
     UPDATE scene_version sv
     SET sort_order = ordered.new_sort_order
     FROM ordered
     WHERE sv.version_id = ordered.version_id
       AND sv.scene_id = ordered.scene_id
       AND sv.sort_order <> ordered.new_sort_order`,
    [versionId]
  );
}


export async function bumpMarkerStructureRevisionInTx(client: PoolClient, versionId: string): Promise<void> {
  await client.query(
    "UPDATE version SET marker_structure_revision = marker_structure_revision + 1 WHERE id = $1",
    [versionId],
  );
}

export async function markerStructureBlocksInTx(client: PoolClient, versionId: string): Promise<Block[]> {
  const { rows } = await client.query<{
    id: string;
    type: Extract<BlockType, "chapter_marker" | "scene_marker" | "rehearsal_marker">;
    parent_marker_id: string | null;
  }>(
    `SELECT sv.block_id AS id, s.type::text AS type,
            s.marker_meta->>'parentMarkerId' AS parent_marker_id
     FROM script_version sv
     JOIN script s ON s.id = sv.snapshot_id
     WHERE sv.version_id = $1
       AND s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
     ORDER BY sv.sort_key`,
    [versionId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    markerMeta: { parentMarkerId: row.parent_marker_id },
  }));
}

const REHEARSAL_MARK_OWNERSHIP_CTE = `WITH version_blocks AS (
  SELECT sv.snapshot_id, sv.block_id, sv.sort_key, s.type::text AS type,
         s.scene_id AS current_scene_id,
         s.rehearsal_mark AS current_mark,
         s.owner_marker_id AS current_owner_marker_id,
         s.marker_meta AS current_meta,
         COUNT(*) FILTER (WHERE s.type = 'chapter_marker')
           OVER (ORDER BY sv.sort_key) AS chapter_seq,
         COUNT(*) FILTER (WHERE s.type IN ('chapter_marker', 'scene_marker'))
           OVER (ORDER BY sv.sort_key) AS scene_seq
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE sv.version_id = $1
), sequenced AS (
  SELECT *,
         MAX(CASE WHEN type = 'chapter_marker' THEN block_id END)
           OVER (PARTITION BY chapter_seq) AS active_chapter_id,
         MAX(CASE WHEN type IN ('chapter_marker', 'scene_marker') THEN block_id END)
           OVER (PARTITION BY scene_seq) AS active_parent_id,
         COUNT(*) FILTER (WHERE type = 'rehearsal_marker')
           OVER (PARTITION BY scene_seq ORDER BY sort_key) AS rehearsal_seq
  FROM version_blocks
), owned AS (
  SELECT *, MAX(CASE WHEN type = 'rehearsal_marker' THEN block_id END)
    OVER (PARTITION BY scene_seq, rehearsal_seq) AS active_marker_id
  FROM sequenced
)`;

const SCOPED_MARKER_OWNERSHIP_CTE = `WITH targets AS (
  SELECT sv.snapshot_id, sv.block_id, sv.sort_key, s.type::text AS type,
         s.scene_id AS current_scene_id,
         s.rehearsal_mark AS current_mark,
         s.owner_marker_id AS current_owner_marker_id,
         s.marker_meta AS current_meta
  FROM script_version sv
  JOIN script s ON s.id = sv.snapshot_id
  WHERE sv.version_id = $1
    AND sv.block_id = ANY($2::text[])
), owned AS (
  SELECT target.*,
         chapter.block_id AS active_chapter_id,
         section.block_id AS active_parent_id,
         CASE WHEN owner.type = 'rehearsal_marker' THEN owner.block_id END AS active_marker_id
  FROM targets target
  LEFT JOIN LATERAL (
    SELECT candidate.block_id
    FROM script_version candidate
    JOIN script candidate_script ON candidate_script.id = candidate.snapshot_id
    WHERE candidate.version_id = $1
      AND candidate.sort_key <= target.sort_key
      AND candidate_script.type = 'chapter_marker'
    ORDER BY candidate.sort_key DESC
    LIMIT 1
  ) chapter ON true
  LEFT JOIN LATERAL (
    SELECT candidate.block_id
    FROM script_version candidate
    JOIN script candidate_script ON candidate_script.id = candidate.snapshot_id
    WHERE candidate.version_id = $1
      AND candidate.sort_key <= target.sort_key
      AND candidate_script.type IN ('chapter_marker', 'scene_marker')
    ORDER BY candidate.sort_key DESC
    LIMIT 1
  ) section ON true
  LEFT JOIN LATERAL (
    SELECT candidate.block_id, candidate_script.type::text AS type
    FROM script_version candidate
    JOIN script candidate_script ON candidate_script.id = candidate.snapshot_id
    WHERE candidate.version_id = $1
      AND candidate.sort_key <= target.sort_key
      AND candidate_script.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
    ORDER BY candidate.sort_key DESC
    LIMIT 1
  ) owner ON true
)`;

const EXPECTED_REHEARSAL_MARK_SQL = `CASE
  WHEN type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker') THEN NULL
  ELSE active_marker_id
END`;

const EXPECTED_OWNER_MARKER_SQL = `CASE
  WHEN type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker') THEN NULL
  ELSE COALESCE(active_marker_id, active_parent_id)
END`;

const EXPECTED_REHEARSAL_SCENE_SQL = `CASE
  WHEN type = 'rehearsal_marker' THEN NULL
  WHEN type IN ('chapter_marker', 'scene_marker') THEN block_id
  ELSE active_parent_id
END`;

const EXPECTED_REHEARSAL_META_SQL = `CASE
  WHEN type = 'chapter_marker'
    THEN (current_meta - 'number') || jsonb_build_object('parentMarkerId', NULL)
  WHEN type = 'scene_marker'
    THEN (current_meta - 'number') || jsonb_build_object('parentMarkerId', active_chapter_id)
  WHEN type = 'rehearsal_marker'
    THEN (current_meta - 'number') || jsonb_build_object('parentMarkerId', active_parent_id)
  ELSE current_meta - 'number'
END`;

const STALE_REHEARSAL_OWNERSHIP_SQL = `current_mark IS DISTINCT FROM ${EXPECTED_REHEARSAL_MARK_SQL}
  OR current_scene_id IS DISTINCT FROM ${EXPECTED_REHEARSAL_SCENE_SQL}
  OR current_owner_marker_id IS DISTINCT FROM ${EXPECTED_OWNER_MARKER_SQL}
  OR current_meta IS DISTINCT FROM ${EXPECTED_REHEARSAL_META_SQL}`;

export async function normalizeRehearsalMarkOwnershipInTx(
  client: PoolClient,
  versionId: string,
  affectedBlockIds?: string[],
): Promise<void> {
  const ownershipCte = affectedBlockIds ? SCOPED_MARKER_OWNERSHIP_CTE : REHEARSAL_MARK_OWNERSHIP_CTE;
  const { rows: stale } = await client.query<{
    snapshot_id: string;
    expected_scene_id: string | null;
    expected_mark: string | null;
    expected_owner_marker_id: string | null;
    expected_meta: MarkerMeta;
  }>(
    `${ownershipCte}
     SELECT snapshot_id,
            ${EXPECTED_REHEARSAL_SCENE_SQL} AS expected_scene_id,
            ${EXPECTED_REHEARSAL_MARK_SQL} AS expected_mark,
            ${EXPECTED_OWNER_MARKER_SQL} AS expected_owner_marker_id,
            ${EXPECTED_REHEARSAL_META_SQL} AS expected_meta
     FROM owned
     WHERE (${STALE_REHEARSAL_OWNERSHIP_SQL})
       AND ($2::text[] IS NULL OR block_id = ANY($2::text[]))`,
    [versionId, affectedBlockIds ?? null],
  );
  if (stale.length === 0) return;
  // 版本体系已退役（#634）：snapshot 引用数恒为 1，一律就地改写，不再 copy-on-write。
  await client.query(
    `UPDATE script s
     SET scene_id = updates.expected_scene_id,
         rehearsal_mark = updates.expected_mark,
         owner_marker_id = updates.expected_owner_marker_id,
         marker_meta = updates.expected_meta
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[])
       AS updates(snapshot_id, expected_scene_id, expected_mark, expected_owner_marker_id, expected_meta)
     WHERE s.id = updates.snapshot_id`,
    [
      stale.map((row) => row.snapshot_id),
      stale.map((row) => row.expected_scene_id),
      stale.map((row) => row.expected_mark),
      stale.map((row) => row.expected_owner_marker_id),
      stale.map((row) => JSON.stringify(row.expected_meta)),
    ],
  );
}

export async function syncSceneVersionsFromMarkersInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
  affectedMarkerIds?: string[],
  deletedMarkerIds: string[] = [],
): Promise<void> {
  if (affectedMarkerIds && affectedMarkerIds.length === 0 && deletedMarkerIds.length === 0) return;
  await client.query(
    `WITH marker_rows AS (
       SELECT
         sv.block_id AS scene_id,
         s.marker_meta,
         s.type::text AS type,
         sv.sort_key,
         sv.snapshot_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
         AND s.type IN ('chapter_marker', 'scene_marker')
     ),
     unique_marker_rows AS (
       SELECT
         scene_id,
         marker_meta,
         type,
         sort_key,
         COUNT(*) FILTER (WHERE type = 'chapter_marker') OVER (ORDER BY sort_key) AS chapter_seq
       FROM (
         SELECT DISTINCT ON (scene_id)
           scene_id,
           marker_meta,
           type,
           sort_key,
           snapshot_id
         FROM marker_rows
         ORDER BY
           scene_id,
           CASE WHEN COALESCE(
             NULLIF(marker_meta->>'name', ''),
             NULLIF(marker_meta->>'synopsis', ''),
             NULLIF(marker_meta->>'actionLine', ''),
             NULLIF(marker_meta->>'music', ''),
             NULLIF(marker_meta->>'stageNotes', ''),
             NULLIF(marker_meta->>'expectedDuration', '')
           ) IS NOT NULL THEN 0 ELSE 1 END,
           sort_key DESC,
           snapshot_id DESC
       ) deduped_marker_rows
	     ),
     marker_scenes AS (
       SELECT
         mr.scene_id,
         mr.marker_meta,
         ROW_NUMBER() OVER (ORDER BY mr.sort_key) - 1 AS sort_order,
         CASE
           WHEN mr.type = 'chapter_marker' THEN NULL
           ELSE (
             SELECT chapter.scene_id
             FROM unique_marker_rows chapter
             WHERE chapter.type = 'chapter_marker'
               AND chapter.chapter_seq = mr.chapter_seq
             ORDER BY chapter.sort_key DESC
             LIMIT 1
           )
         END AS parent_id
       FROM unique_marker_rows mr
     ),
     ensured AS (
       INSERT INTO scene (id, production_id)
       SELECT scene_id, $2
       FROM marker_scenes
       WHERE $3::text[] IS NULL OR scene_id = ANY($3::text[])
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     ),
     upserted AS (
       INSERT INTO scene_version (
         scene_id, version_id, name, sort_order, parent_id,
         synopsis, action_line, music, stage_notes, expected_duration
       )
       SELECT
         ms.scene_id,
         $1,
         COALESCE(ms.marker_meta->>'name', ''),
         ms.sort_order,
         ms.parent_id,
         ms.marker_meta->>'synopsis',
         ms.marker_meta->>'actionLine',
         ms.marker_meta->>'music',
         ms.marker_meta->>'stageNotes',
         ms.marker_meta->>'expectedDuration'
       FROM marker_scenes ms
       WHERE $3::text[] IS NULL OR ms.scene_id = ANY($3::text[])
       ON CONFLICT (scene_id, version_id) DO UPDATE
         SET name = EXCLUDED.name,
             sort_order = EXCLUDED.sort_order,
             parent_id = EXCLUDED.parent_id,
             synopsis = EXCLUDED.synopsis,
             action_line = EXCLUDED.action_line,
             music = EXCLUDED.music,
             stage_notes = EXCLUDED.stage_notes,
             expected_duration = EXCLUDED.expected_duration
       RETURNING scene_id
     )
     SELECT COUNT(*) FROM upserted`,
    [versionId, productionId, affectedMarkerIds ?? null]
  );
  if (!affectedMarkerIds) {
    await client.query(
      `WITH marker_scene_ids AS (
         SELECT sv.block_id AS scene_id
         FROM script_version sv
         JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1
           AND s.type IN ('chapter_marker', 'scene_marker')
       )
       DELETE FROM scene_version sv
       WHERE sv.version_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM marker_scene_ids ms
           WHERE ms.scene_id = sv.scene_id
         )`,
      [versionId],
    );
    await normalizeSceneOwnershipOrderInTx(client, versionId);
    return;
  }
  if (deletedMarkerIds.length > 0) {
    await client.query(
      "DELETE FROM scene_version WHERE version_id = $1 AND scene_id = ANY($2::text[])",
      [versionId, deletedMarkerIds],
    );
  }
}
