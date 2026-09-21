import type { PoolClient } from "pg";
import type { Block, BlockType, MarkerMeta } from "./script-types";
import { genSnapshotId } from "./script-row-model";

// 标记结构事务 helper（#486 从 lib/db.ts 搬出）：在写侧事务内维护「标记 ↔ 场次 ↔ 归属」
// 不变量——scene_version 排序归一、marker_structure_revision 递增、排练标记归属回填、
// 从标记同步 scene_version。只被 flush / import / patch 三条写路径在事务内调用，
// 自己不开事务、不拿 pool。SQL 片段见 script-marker-sql，纯领域判定见 script-marker-domain。

export async function normalizeSceneOwnershipOrderInTx(client: PoolClient, versionId: string): Promise<void> {
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
    ref_count: number;
  }>(
    `${ownershipCte}
     SELECT snapshot_id,
            (SELECT COUNT(*)::int FROM script_version refs WHERE refs.snapshot_id = owned.snapshot_id) AS ref_count,
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
  const exclusive = stale.filter((row) => row.ref_count <= 1);
  if (exclusive.length > 0) {
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
        exclusive.map((row) => row.snapshot_id),
        exclusive.map((row) => row.expected_scene_id),
        exclusive.map((row) => row.expected_mark),
        exclusive.map((row) => row.expected_owner_marker_id),
        exclusive.map((row) => JSON.stringify(row.expected_meta)),
      ],
    );
  }
  const shared = stale.filter((row) => row.ref_count > 1);
  for (const row of shared) {
    const newSnapshotId = genSnapshotId();
    await client.query(
      `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
       SELECT $1, block_id, production_id, sort_key, $2, $3, $4, type, content, stage_comment, $5::jsonb, force_show_character_name
       FROM script WHERE id = $6`,
      [newSnapshotId, row.expected_scene_id, row.expected_mark, row.expected_owner_marker_id, JSON.stringify(row.expected_meta), row.snapshot_id],
    );
    await client.query(
      `INSERT INTO script_character (script_id, character_id, position, annotation)
       SELECT $1, character_id, position, annotation FROM script_character WHERE script_id = $2`,
      [newSnapshotId, row.snapshot_id],
    );
    // 挂载边 CoW 复制已随 #420 退役：node_mount 一律锚稳定 block_id，快照更替
    // 与挂载无关（版本纪律：挂载即对最新状态的挂载）
    await client.query(
      "UPDATE script_version SET snapshot_id = $1 WHERE version_id = $2 AND snapshot_id = $3",
      [newSnapshotId, versionId, row.snapshot_id],
    );
  }
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
