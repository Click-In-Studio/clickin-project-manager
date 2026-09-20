import { getPool } from "./pg";
export type { UserInfo } from "./account/db-feishu";
export { upsertFeishuUser, getFeishuUser, attachFeishuToUser } from "./account/db-feishu";
import type { UserInfo } from "./account/db-feishu";
import type { Pool, PoolClient } from "pg";
import type { Block, BlockType, Character, Scene, ScriptState, ScriptConfig, PageLayout, ScriptTextLayoutMode, MarkerMeta } from "./script/script-types";
import { DEFAULT_SCRIPT_CONFIG, usesRehearsalMarksByDefault } from "./script/script-types";
import type { PermissionContext } from "./perm/permissions";
type AtomicPermission = string;

export type ProductionAccess = {
  permCtx: PermissionContext;
  isArchived: boolean;
};
// 角色名单（ROLE_NAMES）已上移为项目模版的一个 slot，见 lib/production/production-template.ts
import { recomputeAndRevokeGrants, revokeAllGrantsForMember } from "./perm/dept-db";
import { normalizeProductionTier, type ProductionTier } from "./account/plan";

import { handleBlockContentChanged, handleBlockDeleted } from "./ops/cue-db";
import { importCueColumnsInTx } from "./ops/cue-list-db";
import type { ScriptPatch, TagEntry } from "./script/script-ops";
import { keyBetween, initialKeys } from "./lex-order";
import { computePageMap, updateEstimatedPageMap, type EstimatedPageMapCache } from "./script/script-page";
import { isKnownTemplateId } from "./script/template";
import { buildMarkerLabelIndex, generatedRehearsalMarksByScene, type MarkerLabelIndex } from "./script/script-generated-labels";
import { MARKER_TYPES_SQL, VERSION_MARKER_LABEL_ROWS_SQL, VERSION_OWNED_BLOCKS_CTE, VERSION_SCENES_FROM_MARKERS_CTE } from "./script/script-marker-sql";
import { getMarkerChange, markerCacheUpdateBlockIds, markerHierarchyUpdateBlockIds, normalizeScriptMarkerInvariants, projectMarkers, sameMarkerStructure, type MarkerChange, type MarkerProjection } from "./script/script-marker-domain";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "./script/script-marker-blocks";
import { randomUUID } from "node:crypto";
import type { ImportTagChanges } from "./import/types";

type MarkerLabelCacheEntry = { revision: string; index: MarkerLabelIndex };

const scriptMarkerGlobals = globalThis as typeof globalThis & {
  __scriptMarkerLabelCache?: Map<string, MarkerLabelCacheEntry>;
  __scriptMarkerLabelLoads?: Map<string, Promise<MarkerLabelCacheEntry | null>>;
  __scriptPageMapCache?: Map<string, EstimatedPageMapCache>;
  __scriptPageMapUpdates?: Map<string, Promise<void>>;
};

const MARKER_LABEL_CACHE_LIMIT = 64;
const markerLabelCache = scriptMarkerGlobals.__scriptMarkerLabelCache ??= new Map();
const markerLabelLoads = scriptMarkerGlobals.__scriptMarkerLabelLoads ??= new Map();
const pageMapCache = scriptMarkerGlobals.__scriptPageMapCache ??= new Map();
const pageMapUpdates = scriptMarkerGlobals.__scriptPageMapUpdates ??= new Map();

function cacheMarkerLabels(versionId: string, entry: MarkerLabelCacheEntry): MarkerLabelCacheEntry {
  markerLabelCache.delete(versionId);
  markerLabelCache.set(versionId, entry);
  while (markerLabelCache.size > MARKER_LABEL_CACHE_LIMIT) {
    const oldest = markerLabelCache.keys().next().value;
    if (oldest === undefined) break;
    markerLabelCache.delete(oldest);
  }
  return entry;
}

export async function getMarkerLabelIndex(
  versionId: string,
  pool: Pool = getPool(),
): Promise<MarkerLabelIndex> {
  const revisionRes = await pool.query<{ revision: string }>(
    "SELECT marker_structure_revision::text AS revision FROM version WHERE id = $1",
    [versionId],
  );
  const revision = revisionRes.rows[0]?.revision;
  if (revision === undefined) return buildMarkerLabelIndex([]);
  const cached = markerLabelCache.get(versionId);
  if (cached?.revision === revision) return cacheMarkerLabels(versionId, cached).index;

  const pending = markerLabelLoads.get(versionId);
  if (pending) {
    const loaded = await pending;
    if (loaded?.revision === revision) return loaded.index;
  }

  const load = pool.query<{
    revision: string;
    id: string | null;
    type: Block["type"] | null;
    parent_marker_id: string | null;
  }>(
    `SELECT v.marker_structure_revision::text AS revision,
            markers.id, markers.type, markers.parent_marker_id
     FROM version v
     LEFT JOIN LATERAL (
       SELECT sv.block_id AS id, s.type::text AS type,
              s.marker_meta->>'parentMarkerId' AS parent_marker_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = v.id
         AND s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
       ORDER BY sv.sort_key
     ) markers ON true
     WHERE v.id = $1`,
    [versionId],
  ).then(({ rows }) => {
    if (rows.length === 0) return null;
    const blocks = rows.flatMap((row) => row.id && row.type
      ? [{ id: row.id, type: row.type, markerMeta: { parentMarkerId: row.parent_marker_id } }]
      : []);
    return cacheMarkerLabels(versionId, {
      revision: rows[0].revision,
      index: buildMarkerLabelIndex(blocks),
    });
  }).finally(() => markerLabelLoads.delete(versionId));
  markerLabelLoads.set(versionId, load);
  return (await load)?.index ?? buildMarkerLabelIndex([]);
}

export async function getFirstRehearsalMarkerLabel(versionId: string): Promise<string | null> {
  const labels = await getMarkerLabelIndex(versionId);
  const markerId = labels.rehearsalLabelByMarkerId.keys().next().value;
  if (!markerId) return null;
  return labels.labelByMarkerId.get(markerId) ?? "（未命名）";
}

// ─── Version types ────────────────────────────────────────────────────────────
// 版本退役 Phase B：name/description/tags/status 列已删（migrate-version-retire.sql），
// 版本只剩线性链结构，留作未来「历史记录 / checkpoint」地基。

export type Version = {
  id: string;
  productionId: string;
  parentVersionId: string | null;
  createdAt: string;
};

// ─── Exported types ───────────────────────────────────────────────────────────

export type DbBlock = Block & { lexKey: string };
// For versioned flush: block + its current snapshot_id (for CoW detection)
export type VersionedDbBlock = DbBlock & { snapshotId: string };
export type DbScene = Scene & { sortOrder: number };
export type DbChar = Character & { sortOrder: number };

export type FlushPayload = {
  upsertBlocks: DbBlock[];
  deleteBlockIds: string[];
  upsertChars: DbChar[];
  deleteCharIds: string[];
  upsertScenes: DbScene[];
  deleteSceneIds: string[];
};

export type VersionedFlushPayload = {
  upsertBlocks: VersionedDbBlock[];
  deleteSnapshotIds: string[];  // snapshot_ids to remove from this version
  upsertChars: DbChar[];
  deleteCharIds: string[];
  upsertScenes: DbScene[];
  deleteSceneIds: string[];
};

// block_id → new snapshot_id for any block whose snapshot was CoW'd
export type VersionedFlushResult = {
  newSnapshotIds: Map<string, string>;
};

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

// ─── Type conversions ─────────────────────────────────────────────────────────

type DbBlockType = "dialogue" | "stage" | "lyric" | "chapter_marker" | "scene_marker" | "rehearsal_marker";

function toDbType(block: Block): DbBlockType {
  if (block.type === "chapter_marker") return "chapter_marker";
  if (block.type === "scene_marker") return "scene_marker";
  if (block.type === "rehearsal_marker") return "rehearsal_marker";
  if (block.type === "stage") return "stage";
  if (block.lyric) return "lyric";
  return "dialogue";
}

function fromDbType(t: DbBlockType): { type: Block["type"]; lyric: boolean } {
  if (t === "chapter_marker") return { type: "chapter_marker", lyric: false };
  if (t === "scene_marker") return { type: "scene_marker", lyric: false };
  if (t === "rehearsal_marker") return { type: "rehearsal_marker", lyric: false };
  if (t === "stage") return { type: "stage", lyric: false };
  if (t === "lyric") return { type: "dialogue", lyric: true };
  return { type: "dialogue", lyric: false };
}

// ─── Row types (internal) ─────────────────────────────────────────────────────

// Versioned block row: comes from JOIN of script_version + script
type BlockRow = {
  snapshot_id: string;
  block_id: string;
  sort_key: string;
  scene_id: string | null;
  rehearsal_mark: string | null;
  owner_marker_id: string | null;
  marker_meta: MarkerMeta | null;
  type: DbBlockType;
  content: string;
  stage_comment: string | null;
  force_show_character_name: boolean;
};
type SceneRow = { id: string; name: string; sort_order: number; parent_id: string | null };
type CharRow  = { id: string; name: string; sort_order: number; is_aggregate: boolean; member_ids: string[] | null };
// script_character uses snapshot_id as the script_id FK
type ScCharRow = { script_id: string; character_id: string; annotation: string | null };

function cleanMarkerMeta(meta: MarkerMeta | null | undefined): MarkerMeta {
  if (!meta || typeof meta !== "object") return {};
  return {
    name: typeof meta.name === "string" ? meta.name : undefined,
    parentMarkerId: typeof meta.parentMarkerId === "string" ? meta.parentMarkerId : meta.parentMarkerId === null ? null : undefined,
    synopsis: typeof meta.synopsis === "string" ? meta.synopsis : undefined,
    actionLine: typeof meta.actionLine === "string" ? meta.actionLine : undefined,
    music: typeof meta.music === "string" ? meta.music : undefined,
    stageNotes: typeof meta.stageNotes === "string" ? meta.stageNotes : undefined,
    expectedDuration: typeof meta.expectedDuration === "string" ? meta.expectedDuration : undefined,
  };
}

function markerMetaJson(block: Pick<Block, "markerMeta">): string {
  return JSON.stringify(cleanMarkerMeta(block.markerMeta));
}

async function bumpMarkerStructureRevisionInTx(client: PoolClient, versionId: string): Promise<void> {
  await client.query(
    "UPDATE version SET marker_structure_revision = marker_structure_revision + 1 WHERE id = $1",
    [versionId],
  );
}

async function markerStructureBlocksInTx(client: PoolClient, versionId: string): Promise<Block[]> {
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

async function normalizeRehearsalMarkOwnershipInTx(
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


async function syncSceneVersionsFromMarkersInTx(
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

function isChapterSceneMarkerType(type: string | null | undefined): boolean {
  return type === "chapter_marker" || type === "scene_marker";
}

function isMarkerBlockType(type: string | null | undefined): boolean {
  return isChapterSceneMarkerType(type) || type === "rehearsal_marker";
}

// ─── Version CRUD ─────────────────────────────────────────────────────────────

type VersionRow = {
  id: string;
  production_id: string;
  parent_version_id: string | null;
  created_at: Date;
};

function rowToVersion(r: VersionRow): Version {
  return {
    id: r.id,
    productionId: r.production_id,
    parentVersionId: r.parent_version_id,
    createdAt: r.created_at.toISOString(),
  };
}

export async function getVersionOpeningChapterId(versionId: string): Promise<string | null> {
  const res = await getPool().query<{ id: string | null }>(
    "SELECT script_config->>'openingChapterMarkerId' AS id FROM version WHERE id = $1",
    [versionId]
  );
  return res.rows[0]?.id ?? null;
}

export async function getVersion(versionId: string): Promise<Version | null> {
  const res = await getPool().query<VersionRow>(
    "SELECT id, production_id, parent_version_id, created_at FROM version WHERE id = $1",
    [versionId]
  );
  return res.rows.length ? rowToVersion(res.rows[0]) : null;
}

/** Returns the most recently created editing version, or null if none. */
export async function getActiveVersionId(productionId: string): Promise<string | null> {
  const res = await getPool().query<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM production WHERE id = $1",
    [productionId]
  );
  return res.rows[0]?.active_version_id ?? null;
}

function genVersionId(): string {
  return `ver_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Creates the very first empty version for a brand-new production. */
/** 传 external ＝调用方已经在事务里了，就用它的连接，BEGIN/COMMIT/release 全归调用方。 */
export async function createInitialVersion(
  productionId: string, external?: PoolClient,
): Promise<string> {
  const versionId = genVersionId();
  const write = async (client: PoolClient) => {
    await client.query(
      "INSERT INTO version (id, production_id) VALUES ($1, $2)",
      [versionId, productionId]
    );
    await client.query(
      "UPDATE production SET active_version_id = $1 WHERE id = $2",
      [versionId, productionId]
    );
  };
  if (external) {
    await write(external);
    return versionId;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await write(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return versionId;
}

// 版本退役 Phase B：createVersion / rollbackToVersion / updateVersionMeta /
// updateVersionStatus 已删除。版本从此线性：每个演出只有 createInitialVersion
// 建的一条活跃版本，历史多版本数据只读保留。未来的「历史记录 / checkpoint」
// 概念在此地基上另行设计，不复用分叉语义。

// ─── Read ─────────────────────────────────────────────────────────────────────

export type ProductionState = {
  state: ScriptState;
  sortKeys: Map<string, string>;    // block_id → sort_key
  snapshotIds: Map<string, string>; // block_id → snapshot_id
};

/**
 * Load all data for a specific version of a production.
 * Returns null if the production doesn't exist.
 */
const VERSION_BLOCK_ROWS_SQL = `SELECT
   s.id AS snapshot_id,
   sv.block_id,
   sv.sort_key,
   s.scene_id,
   s.rehearsal_mark,
   s.owner_marker_id,
   s.marker_meta,
   s.type,
   s.content,
   s.stage_comment,
   s.force_show_character_name
 FROM script_version sv
 JOIN script s ON s.id = sv.snapshot_id
 WHERE sv.version_id = $1`;

type LoadedVersionBlocks = {
  blocks: Block[];
  sortKeys: Map<string, string>;
  snapshotIds: Map<string, string>;
};

async function assembleVersionBlocks(rows: BlockRow[]): Promise<LoadedVersionBlocks> {
  const pool = getPool();
  // script_character joins on snapshot_id (script.id)
  const snapshotIds_arr = rows.map(r => r.snapshot_id);
  const scCharRes = snapshotIds_arr.length > 0
    ? await pool.query<ScCharRow>(
        "SELECT script_id, character_id, annotation FROM script_character WHERE script_id = ANY($1::text[]) ORDER BY script_id, position",
        [snapshotIds_arr]
      )
    : { rows: [] as ScCharRow[] };

  const charsBySnapshot = new Map<string, string[]>();
  const annotationsBySnapshot = new Map<string, Record<string, string>>();
  for (const row of scCharRes.rows) {
    if (!charsBySnapshot.has(row.script_id)) charsBySnapshot.set(row.script_id, []);
    charsBySnapshot.get(row.script_id)!.push(row.character_id);
    if (row.annotation) {
      if (!annotationsBySnapshot.has(row.script_id)) annotationsBySnapshot.set(row.script_id, {});
      annotationsBySnapshot.get(row.script_id)![row.character_id] = row.annotation;
    }
  }

  const sortKeys   = new Map<string, string>();
  const snapshotIds = new Map<string, string>();

  const blocks: Block[] = rows.map(row => {
    sortKeys.set(row.block_id, row.sort_key);
    snapshotIds.set(row.block_id, row.snapshot_id);
    const { type, lyric } = fromDbType(row.type);
    return {
      id: row.block_id,
      type,
      lyric,
      content: row.content,
      stageComment: row.stage_comment,
      forceShowCharacterName: row.force_show_character_name,
      sceneId: isChapterSceneMarkerType(row.type) ? row.block_id : row.scene_id,
      rehearsalMark: row.rehearsal_mark,
      ownerMarkerId: isMarkerBlockType(row.type) ? undefined : row.owner_marker_id,
      markerMeta: cleanMarkerMeta(row.marker_meta),
      characterIds: charsBySnapshot.get(row.snapshot_id) ?? [],
      characterAnnotations: annotationsBySnapshot.get(row.snapshot_id) ?? {},
    };
  });
  return { blocks, sortKeys, snapshotIds };
}

/** 只装正文块序列（含 marker 行）。分页测算等只消费 blocks 的读者用这个，
 *  别为它扛整本（scenes/characters/config 三路查询与 loadProduction 的
 *  openingChapter 写回都省掉，#461）。 */
export async function loadVersionBlocks(versionId: string): Promise<LoadedVersionBlocks> {
  const res = await getPool().query<BlockRow>(
    `${VERSION_BLOCK_ROWS_SQL} ORDER BY sv.sort_key`,
    [versionId]
  );
  return assembleVersionBlocks(res.rows);
}

/** 按 block id 定点装块（含正文与角色挂载）。审计快照等只看少数行的读者用（#461）。 */
export async function loadVersionBlocksByIds(versionId: string, blockIds: string[]): Promise<Block[]> {
  if (blockIds.length === 0) return [];
  const res = await getPool().query<BlockRow>(
    `${VERSION_BLOCK_ROWS_SQL} AND sv.block_id = ANY($2::text[]) ORDER BY sv.sort_key`,
    [versionId, blockIds]
  );
  return (await assembleVersionBlocks(res.rows)).blocks;
}

/** 非 marker 块的 id 序列（正文顺序），不拖内容。 */
export async function listTextBlockIdsByVersion(versionId: string): Promise<string[]> {
  const res = await getPool().query<{ block_id: string }>(
    `SELECT sv.block_id
     FROM script_version sv
     JOIN script s ON s.id = sv.snapshot_id
     WHERE sv.version_id = $1 AND s.type NOT IN (${MARKER_TYPES_SQL})
     ORDER BY sv.sort_key`,
    [versionId]
  );
  return res.rows.map(r => r.block_id);
}

const PRODUCTION_CONFIG_SQL = `SELECT p.script_config AS production_script_config,
        v.script_config AS version_script_config,
        sv.page_layout, sv.text_layout_mode,
        sv.template_overrides->>'templateId' AS template_id
 FROM production p
 JOIN version v ON v.production_id = p.id
 LEFT JOIN script_view sv ON sv.id = p.master_view_id
 WHERE p.id = $1 AND v.id = $2`;

type ProductionConfigRow = {
  production_script_config: Partial<ScriptConfig> | null;
  version_script_config: Partial<ScriptConfig> | null;
  page_layout: string | null;
  text_layout_mode: string | null;
  template_id: string | null;
};

/** ScriptConfig 的唯一装配口（loadProduction 与 getScriptConfig 共用）。
 *  openingChapterMarkerId 配置无效（缺失/指向已不存在的章 marker）时兜底到第一章；
 *  兜底值经 backfillOpeningChapterMarkerId 返回，由 loadProduction 决定是否写回。 */
function assembleScriptConfig(
  row: ProductionConfigRow,
  chapterMarkerIds: string[],
): { config: ScriptConfig; backfillOpeningChapterMarkerId: string | null } {
  // 版式只有 script_view 一处真相（#336 B2）：主本行装配进 ScriptConfig，JSONB 里
  // 即便残留旧键也不算数。无主本（不应发生）落缺省。
  const masterLayout = scriptViewLayout(row);
  // 排版模版 id 也住在主本上（template_overrides.templateId，#338 T3）；不认识的 id 当没有
  const templateId = isKnownTemplateId(row.template_id) ? row.template_id : null;
  const rawVersionConfig = row.version_script_config;
  let openingChapterMarkerId =
    typeof rawVersionConfig?.openingChapterMarkerId === "string"
      ? rawVersionConfig.openingChapterMarkerId
      : null;
  let backfillOpeningChapterMarkerId: string | null = null;
  if (!openingChapterMarkerId || !chapterMarkerIds.includes(openingChapterMarkerId)) {
    openingChapterMarkerId = chapterMarkerIds[0] ?? null;
    backfillOpeningChapterMarkerId = openingChapterMarkerId;
  }
  // 后者覆盖前者：主本的版式与模版 id 压过 JSONB 里的残留键（scriptViewLayout 只产出
  // pageLayout / textLayoutMode 两个键，templateId 单独装配）
  return {
    config: {
      ...DEFAULT_SCRIPT_CONFIG,
      ...(row.production_script_config ?? {}),
      ...(rawVersionConfig ?? {}),
      ...masterLayout,
      templateId,
      openingChapterMarkerId,
    },
    backfillOpeningChapterMarkerId,
  };
}

/** 只装配 ScriptConfig，不拖 blocks/scenes/characters（#461）。与 loadProduction
 *  同一套装配，但纯读——不做 openingChapterMarkerId 的写回。 */
export async function getScriptConfig(productionId: string, versionId: string): Promise<ScriptConfig | null> {
  const pool = getPool();
  const [prodRes, chapterRes] = await Promise.all([
    pool.query<ProductionConfigRow>(PRODUCTION_CONFIG_SQL, [productionId, versionId]),
    pool.query<{ block_id: string }>(
      `SELECT sv.block_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND s.type = 'chapter_marker'
       ORDER BY sv.sort_key`,
      [versionId]
    ),
  ]);
  if (!prodRes.rows.length) return null;
  return assembleScriptConfig(prodRes.rows[0], chapterRes.rows.map(r => r.block_id)).config;
}

export async function loadProduction(productionId: string, versionId: string): Promise<ProductionState | null> {
  const pool = getPool();

  const [[loadedBlocks, scenesRes, charsRes], prodRes] = await Promise.all([
	    Promise.all([
	      loadVersionBlocks(versionId),
      pool.query<SceneRow>(
        `${VERSION_SCENES_FROM_MARKERS_CTE}
         SELECT ms.id,
                COALESCE(ms.marker_meta->>'name', '') AS name,
                ms.sort_order, ms.parent_id
         FROM marker_scenes ms
         ORDER BY ms.sort_order`,
        [versionId]
      ),
      pool.query<CharRow>(
        `SELECT cv.character_id AS id, cv.name, cv.sort_order, cv.is_aggregate,
                COALESCE(array_remove(array_agg(ca.member_id ORDER BY ca.member_id), NULL), ARRAY[]::text[]) AS member_ids
         FROM character_version cv
         LEFT JOIN character_aggregate ca ON ca.aggregate_id = cv.character_id
         WHERE cv.version_id = $1
         GROUP BY cv.character_id, cv.name, cv.sort_order, cv.is_aggregate
         ORDER BY cv.sort_order`,
        [versionId]
      ),
    ]),
    pool.query<ProductionConfigRow>(PRODUCTION_CONFIG_SQL, [productionId, versionId]),
  ]);

  if (!prodRes.rows.length) return null;
  const { blocks, sortKeys, snapshotIds } = loadedBlocks;
  const markerLabels = buildMarkerLabelIndex(blocks);

  const { config, backfillOpeningChapterMarkerId } = assembleScriptConfig(
    prodRes.rows[0],
    blocks.filter((block) => block.type === "chapter_marker").map((block) => block.id),
  );
  if (backfillOpeningChapterMarkerId) {
    await pool.query(
      "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2",
      [JSON.stringify({ openingChapterMarkerId: backfillOpeningChapterMarkerId }), versionId]
    );
  }

  return {
    state: {
      blocks,
      scenes: scenesRes.rows.map(r => ({
        id: r.id,
        number: markerLabels.labelByMarkerId.get(r.id) ?? "",
        name: r.name,
        parentId: r.parent_id,
      })),
      characters: charsRes.rows.map(r => ({ id: r.id, name: r.name, isAggregate: r.is_aggregate, memberIds: r.member_ids ?? [] })),
      config,
    },
    sortKeys,
    snapshotIds,
  };
}

export async function saveScriptConfig(productionId: string, versionId: string | null, config: ScriptConfig): Promise<void> {
  const pool = getPool();
  // 版式不进 JSONB（#336 B2）：写主本的 script_view 行。
  const configJson = JSON.stringify({
    stageDelimOpen: config.stageDelimOpen,
    stageDelimClose: config.stageDelimClose,
    useRehearsalMarks: config.useRehearsalMarks,
  });
  await pool.query("UPDATE production SET script_config = $1 WHERE id = $2", [configJson, productionId]);
  const masterViewId = await ensureMasterScriptView(productionId);
  // 模版 id 进 template_overrides（JSONB，保留将来的覆盖项）；null = 删掉键（按 textLayoutMode 回退）
  const templateId = isKnownTemplateId(config.templateId) ? config.templateId : null;
  const configUpdate = await pool.query<{ pagination_changed: boolean }>(
    `WITH previous AS (
       SELECT page_layout, text_layout_mode, template_overrides->>'templateId' AS template_id
       FROM script_view WHERE id = $1
     ), updated AS (
       UPDATE script_view
          SET page_layout = $2,
              text_layout_mode = $3,
              template_overrides = CASE
                WHEN $4::text IS NULL THEN COALESCE(template_overrides, '{}'::jsonb) - 'templateId'
                ELSE COALESCE(template_overrides, '{}'::jsonb) || jsonb_build_object('templateId', $4::text)
              END
        WHERE id = $1 RETURNING 1
     )
     SELECT previous.page_layout IS DISTINCT FROM $2
         OR previous.text_layout_mode IS DISTINCT FROM $3
         OR previous.template_id IS DISTINCT FROM $4::text AS pagination_changed
     FROM previous, updated`,
    [masterViewId, config.pageLayout, config.textLayoutMode, templateId]
  );
  if (versionId) {
    await pool.query(
      "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2 AND production_id = $3",
      [JSON.stringify({
        openingChapterMarkerId: config.openingChapterMarkerId,
        showOpeningChapter: config.showOpeningChapter,
      }), versionId, productionId]
    );
    if (configUpdate.rows[0]?.pagination_changed) {
      await scheduleEstimatedPageMapSave(productionId, versionId, "full");
    }
  }
}

export async function saveOpeningChapterMarkerId(
  productionId: string,
  versionId: string,
  openingChapterMarkerId: string | null,
  showOpeningChapter?: boolean,
): Promise<void> {
  const config = showOpeningChapter === undefined
    ? { openingChapterMarkerId }
    : { openingChapterMarkerId, showOpeningChapter };
  await getPool().query(
    "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2 AND production_id = $3",
    [JSON.stringify(config), versionId, productionId]
  );
}

export async function saveScriptStageDelimiters(productionId: string, stageDelimOpen: string, stageDelimClose: string): Promise<void> {
  await getPool().query(
    "UPDATE production SET script_config = script_config || $1::jsonb WHERE id = $2",
    [JSON.stringify({ stageDelimOpen, stageDelimClose }), productionId]
  );
}

// ── script_view（本子）───────────────────────────────────────────────────────
// #336 B2：一个演出 N 个本子 + 一个主本，版式（pageLayout / textLayoutMode）只存在
// script_view 行上。本阶段只有主本一条；多本、权限门、内容过滤在 #339。

function newScriptViewId(): string {
  return `sv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isPageLayout(value: unknown): value is PageLayout {
  return typeof value === "string" && (PAGE_LAYOUTS as string[]).includes(value);
}

function scriptViewLayout(row: { page_layout: string | null; text_layout_mode: string | null } | undefined): {
  pageLayout: PageLayout; textLayoutMode: ScriptTextLayoutMode;
} {
  return {
    pageLayout: isPageLayout(row?.page_layout) ? row!.page_layout : DEFAULT_SCRIPT_CONFIG.pageLayout,
    textLayoutMode: row?.text_layout_mode === "compact" ? "compact" : DEFAULT_SCRIPT_CONFIG.textLayoutMode,
  };
}

/**
 * 给演出建主本（createProduction 事务内调用）。版式取缺省——建项目时还没人选过版式。
 */
async function createMasterScriptView(productionId: string, client: PoolClient | Pool): Promise<string> {
  const id = newScriptViewId();
  await client.query(
    "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
    [id, productionId],
  );
  await client.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [id, productionId]);
  return id;
}

export async function getMasterScriptViewId(productionId: string): Promise<string | null> {
  const res = await getPool().query<{ master_view_id: string | null }>(
    "SELECT master_view_id FROM production WHERE id = $1", [productionId],
  );
  return res.rows[0]?.master_view_id ?? null;
}

/** 写路径的自愈：主本缺席（迁移前建的演出且迁移未跑）就补一条，别让版式保存静默丢失。 */
async function ensureMasterScriptView(productionId: string): Promise<string> {
  const existing = await getMasterScriptViewId(productionId);
  if (existing) return existing;
  return createMasterScriptView(productionId, getPool());
}

/** Load the pre-computed page map for a production (keyed by script_view id → blockId → page). */
export async function loadPageMap(productionId: string): Promise<Record<string, Record<string, number>> | null> {
  const res = await getPool().query<{ page_map: Record<string, Record<string, number>> | null }>(
    "SELECT page_map FROM production WHERE id = $1",
    [productionId]
  );
  return res.rows[0]?.page_map ?? null;
}

/**
 * 估算页码的统一读口（#336 阶段 B）。
 *
 * 页码有且只有这一个读者：读 `production.page_map`——applyPatchToDB 提交后按四种
 * 版式各预算一份、saveScriptConfig 改版式时全量重算的那份——再按演出**实际**版式取。
 * 此前四个消费点各自拉全本现算，其中三处硬编码 a4/center、cue 页漏传 textLayoutMode：
 * 用 letter / compact 的剧组，搜索与 @提及 报的是别的版式的页码。
 *
 * 存储缺失（从未写过、非 head 版本、上次 fire-and-forget 失败）时现算兜底；算法与
 * 存储同源（computePageMap），两边不会分叉。阶段 B2 起 page_map 改按 script_view id
 * 键，只需改这里。「页码到底该是什么」（实时重算 / 锁页 A 页 / 换坐标）归 #349。
 */
export async function getEstimatedPageMap(
  productionId: string,
  versionId: string,
  preloaded?: ScriptState | null,
): Promise<Record<string, number>> {
  // 存储由提交后的异步任务写入；等在途的那次写完，别读到上一版的页码
  await pageMapUpdates.get(versionId)?.catch(() => {});
  const res = await getPool().query<{
    page_map: Record<string, Record<string, number>> | null;
    active_version_id: string | null;
    master_view_id: string | null;
    page_layout: string | null;
    text_layout_mode: string | null;
    template_id: string | null;
  }>(
    `SELECT p.page_map, p.active_version_id, p.master_view_id, sv.page_layout, sv.text_layout_mode,
            sv.template_overrides->>'templateId' AS template_id
     FROM production p
     LEFT JOIN script_view sv ON sv.id = p.master_view_id
     WHERE p.id = $1`,
    [productionId],
  );
  const row = res.rows[0];
  if (!row) return {};
  // 页码 = 主本的页码（epic 决策 1 给 #349 留的位置）；page_map 按 view id 键
  if (row.active_version_id === versionId && row.master_view_id) {
    const stored = row.page_map?.[row.master_view_id];
    if (stored) return stored;
  }
  // 兜底重算只吃 blocks——别为它扛整本（#461）
  const blocks = preloaded?.blocks ?? (await loadVersionBlocks(versionId)).blocks;
  const { pageLayout, textLayoutMode } = scriptViewLayout(row);
  return computePageMap(blocks, pageLayout, textLayoutMode, false, isKnownTemplateId(row.template_id) ? row.template_id : null);
}

/** Stores a pre-computed page map keyed by script_view id（测试与修复脚本用；线上写入走 saveEstimatedPageMaps）. */
export async function savePageMap(
  productionId: string,
  pageMap: Record<string, Record<string, number>>,
): Promise<void> {
  deletePageMapCacheEntries(`${productionId}:`);
  await writePageMap(productionId, pageMap);
}

function deletePageMapCacheEntries(prefix: string): void {
  for (const key of pageMapCache.keys()) {
    if (key.startsWith(prefix)) pageMapCache.delete(key);
  }
}

async function writePageMap(
  productionId: string,
  pageMap: Record<string, Record<string, number>>,
): Promise<void> {
  await getPool().query(
    "UPDATE production SET page_map = $1 WHERE id = $2 AND page_map IS DISTINCT FROM $1::jsonb",
    [JSON.stringify(pageMap), productionId]
  );
}

// ─── Write ────────────────────────────────────────────────────────────────────

function genSnapshotId(): string {
  return `sn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function genBlockId(): string {
  return `blk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Versioned flush with copy-on-write semantics for blocks.
 * Scenes and characters are version-unaware (production-scoped) for now.
 * Returns a map of block_id → new snapshot_id for any CoW'd blocks.
 */
export async function flushToDBVersioned(
  productionId: string,
  versionId: string,
  payload: VersionedFlushPayload,
): Promise<VersionedFlushResult> {
  const { upsertBlocks: rawUpsertBlocks, deleteSnapshotIds, upsertChars, deleteCharIds, upsertScenes, deleteSceneIds } = payload;
  const upsertBlocks = withLegacyOwnershipProjection(withMarkerOwnership(rawUpsertBlocks));
  const newSnapshotIds = new Map<string, string>();
  const mayChangeMarkerStructure = upsertBlocks.length > 0 || deleteSnapshotIds.length > 0;

  if (!upsertBlocks.length && !deleteSnapshotIds.length && !upsertChars.length &&
      !deleteCharIds.length && !upsertScenes.length && !deleteSceneIds.length) {
    return { newSnapshotIds };
  }

  // ── Phase 1: snapshot pre-flush for cue drift ─────────────────────────────
  const oldContents  = new Map<string, string>(); // snapshot_id → old content
  const snapshotAdj  = new Map<string, { prevId: string | null; nextId: string | null }>();

  if (upsertBlocks.length > 0) {
    const snIds = upsertBlocks.map(b => b.snapshotId);
    const res = await getPool().query<{ id: string; content: string }>(
      "SELECT id, content FROM script WHERE id = ANY($1::text[])", [snIds]
    );
    for (const r of res.rows) oldContents.set(r.id, r.content);
  }

  if (deleteSnapshotIds.length > 0) {
    const res = await getPool().query<{ id: string; prev_id: string | null; next_id: string | null }>(
      `WITH ordered AS (
         SELECT sv.snapshot_id AS id,
           LAG(sv.snapshot_id)  OVER (ORDER BY sv.sort_key) AS prev_id,
           LEAD(sv.snapshot_id) OVER (ORDER BY sv.sort_key) AS next_id
         FROM script_version sv WHERE sv.version_id = $1
       )
       SELECT id, prev_id, next_id FROM ordered WHERE id = ANY($2::text[])`,
      [versionId, deleteSnapshotIds]
    );
    for (const r of res.rows) snapshotAdj.set(r.id, { prevId: r.prev_id, nextId: r.next_id });
  }

  // ── Phase 2: main transaction ─────────────────────────────────────────────
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const previousMarkerStructure = mayChangeMarkerStructure
      ? await markerStructureBlocksInTx(client, versionId)
      : [];

    // Scenes: ensure identity row exists in scene (FK anchor), then upsert versioned data
    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertScenes.map(s => s.id), productionId]
      );
      await client.query(
        `INSERT INTO scene_version (scene_id, version_id, name, sort_order, parent_id)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::text[])
         ON CONFLICT (scene_id, version_id) DO UPDATE
           SET name = EXCLUDED.name,
               sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
        [upsertScenes.map(s => s.id), versionId,
         upsertScenes.map(s => s.name), upsertScenes.map(s => s.sortOrder),
         upsertScenes.map(s => s.parentId ?? null)]
      );
    }

    // Characters: ensure identity row exists in character (FK anchor), then upsert versioned data
    if (upsertChars.length > 0) {
      await client.query(
        `INSERT INTO character (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertChars.map(c => c.id), productionId]
      );
      await client.query(
        `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::bool[])
         ON CONFLICT (character_id, version_id) DO UPDATE
           SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_aggregate = EXCLUDED.is_aggregate`,
        [upsertChars.map(c => c.id), versionId,
         upsertChars.map(c => c.name), upsertChars.map(c => c.sortOrder),
         upsertChars.map(c => c.isAggregate)]
      );
    }

    // Blocks: copy-on-write for multi-referenced snapshots
    for (const block of upsertBlocks) {
      const isNew = block.snapshotId.startsWith('sn_new_');

      if (isNew) {
        // Brand new block: insert snapshot + relation
        const snapshotId = genSnapshotId();
        await client.query(
          `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::block_type, $9, $10, $11::jsonb, $12)`,
          [snapshotId, block.id, productionId, block.lexKey,
           block.sceneId ?? null, block.rehearsalMark ?? null, block.ownerMarkerId ?? null, toDbType(block), block.content,
           block.stageComment?.trim() || null, markerMetaJson(block), block.forceShowCharacterName ?? false]
        );
        await client.query(
          "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) VALUES ($1, $2, $3, $4)",
          [snapshotId, versionId, block.id, block.lexKey]
        );
        if (block.characterIds.length > 0) {
          const scRows = block.characterIds.map((cid, pos) => ({
            sid: snapshotId, cid, pos, ann: block.characterAnnotations[cid] ?? null,
          }));
          await client.query(
            `INSERT INTO script_character (script_id, character_id, position, annotation)
             SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
            [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)]
          );
        }
        newSnapshotIds.set(block.id, snapshotId);
      } else {
        // Existing block: check reference count for CoW
        const refRes = await client.query<{ cnt: string }>(
          "SELECT COUNT(*) AS cnt FROM script_version WHERE snapshot_id = $1",
          [block.snapshotId]
        );
        const refCount = parseInt(refRes.rows[0].cnt, 10);

        if (refCount <= 1) {
          // Sole reference: update in-place
          await client.query(
            `UPDATE script SET scene_id = $1, rehearsal_mark = $2, owner_marker_id = $3, type = $4::block_type, content = $5, stage_comment = $6, marker_meta = $7::jsonb, force_show_character_name = $8 WHERE id = $9`,
            [block.sceneId ?? null, block.rehearsalMark ?? null, block.ownerMarkerId ?? null, toDbType(block), block.content,
             block.stageComment?.trim() || null, markerMetaJson(block), block.forceShowCharacterName ?? false, block.snapshotId]
          );
          // Update sort_key in relation table
          await client.query(
            "UPDATE script_version SET sort_key = $1 WHERE snapshot_id = $2 AND version_id = $3",
            [block.lexKey, block.snapshotId, versionId]
          );
          // Replace character associations
          await client.query(
            "DELETE FROM script_character WHERE script_id = $1", [block.snapshotId]
          );
          if (block.characterIds.length > 0) {
            const scRows = block.characterIds.map((cid, pos) => ({
              sid: block.snapshotId, cid, pos, ann: block.characterAnnotations[cid] ?? null,
            }));
            await client.query(
              `INSERT INTO script_character (script_id, character_id, position, annotation)
               SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
              [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)]
            );
          }
        } else {
          // Multi-referenced: copy-on-write
          const newSnapshotId = genSnapshotId();
          await client.query(
            `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::block_type, $9, $10, $11::jsonb, $12)`,
            [newSnapshotId, block.id, productionId, block.lexKey,
             block.sceneId ?? null, block.rehearsalMark ?? null, block.ownerMarkerId ?? null, toDbType(block), block.content,
             block.stageComment?.trim() || null, markerMetaJson(block), block.forceShowCharacterName ?? false]
          );
          // Remap relation for this version to the new snapshot
          await client.query(
            "UPDATE script_version SET snapshot_id = $1, sort_key = $2 WHERE snapshot_id = $3 AND version_id = $4",
            [newSnapshotId, block.lexKey, block.snapshotId, versionId]
          );
          if (block.characterIds.length > 0) {
            const scRows = block.characterIds.map((cid, pos) => ({
              sid: newSnapshotId, cid, pos, ann: block.characterAnnotations[cid] ?? null,
            }));
            await client.query(
              `INSERT INTO script_character (script_id, character_id, position, annotation)
               SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
              [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)]
            );
          }
          // block_tag rows are keyed by logical block_id (block.id), not by
          // snapshot_id, so they do not need to be copied during CoW.
          // （挂载边 CoW 复制已随 #420 退役：node_mount 锚稳定 block_id）
          newSnapshotIds.set(block.id, newSnapshotId);
        }
      }
    }

    // Deletes: remove from version relation; garbage-collect orphan snapshots.
    // Two separate statements — CTE and its main query share one snapshot and
    // cannot see each other's writes, so split into sequential statements.
    if (deleteSnapshotIds.length > 0) {
      await client.query(
        "DELETE FROM script_version WHERE snapshot_id = ANY($1::text[]) AND version_id = $2",
        [deleteSnapshotIds, versionId]
      );
      await client.query(
        `DELETE FROM script s
         WHERE s.id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM script_version sv WHERE sv.snapshot_id = s.id)`,
        [deleteSnapshotIds]
      );
    }

    // Version-scoped deletes: remove from versioned tables only; keep scene/character
    // rows as FK anchors for script.scene_id and event_schedule_item.target_scene_id.
    if (deleteCharIds.length > 0)
      await client.query(
        "DELETE FROM character_version WHERE character_id = ANY($1::text[]) AND version_id = $2",
        [deleteCharIds, versionId]
      );
    if (deleteSceneIds.length > 0)
      await client.query(
        "DELETE FROM scene_version WHERE scene_id = ANY($1::text[]) AND version_id = $2",
        [deleteSceneIds, versionId]
      );
    if (upsertScenes.length > 0 || deleteSceneIds.length > 0) {
      await normalizeSceneOwnershipOrderInTx(client, versionId);
    }
    if (mayChangeMarkerStructure) {
      await normalizeRehearsalMarkOwnershipInTx(client, versionId);
      const finalMarkerStructure = await markerStructureBlocksInTx(client, versionId);
      if (!sameMarkerStructure(previousMarkerStructure, finalMarkerStructure)) {
        await bumpMarkerStructureRevisionInTx(client, versionId);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ── Phase 3: version-aware cue drift (best-effort) ────────────────────────
  const driftJobs: Promise<void>[] = [];
  for (const snapshotId of deleteSnapshotIds) {
    const adj = snapshotAdj.get(snapshotId);
    if (adj) driftJobs.push(handleBlockDeleted(snapshotId, adj.prevId, adj.nextId, versionId));
  }
  for (const block of upsertBlocks) {
    const effectiveSnapshotId = newSnapshotIds.get(block.id) ?? block.snapshotId;
    const old = oldContents.get(block.snapshotId);
    if (old !== undefined && old !== block.content)
      driftJobs.push(handleBlockContentChanged(block.snapshotId, effectiveSnapshotId, old, block.content, versionId));
  }
  if (driftJobs.length > 0) await Promise.allSettled(driftJobs);

  return { newSnapshotIds };
}

/** Legacy flush used by management pages (import-script, import-scenes).
 *  Operates on the active editing version; no CoW for blocks. */
export async function flushToDB(productionId: string, payload: FlushPayload): Promise<void> {
  const { upsertBlocks: rawUpsertBlocks, deleteBlockIds, upsertChars, deleteCharIds, upsertScenes, deleteSceneIds } = payload;
  const upsertBlocks = withLegacyOwnershipProjection(withMarkerOwnership(rawUpsertBlocks));
  const mayChangeMarkerStructure = upsertBlocks.length > 0 || deleteBlockIds.length > 0;
  if (!upsertBlocks.length && !deleteBlockIds.length && !upsertChars.length &&
      !deleteCharIds.length && !upsertScenes.length && !deleteSceneIds.length) return;

  const versionId = await getActiveVersionId(productionId);

  // ── Phase 1: snapshot pre-flush state needed for cue drift ────────────────
  const oldContents = new Map<string, string>();
  const blockAdj = new Map<string, { prevId: string | null; nextId: string | null }>();

  if (upsertBlocks.length > 0) {
    const ids = upsertBlocks.map(b => b.id);
    const res = await getPool().query<{ id: string; content: string }>(
      "SELECT id, content FROM script WHERE id = ANY($1::text[])", [ids]
    );
    for (const r of res.rows) oldContents.set(r.id, r.content);
  }

  if (deleteBlockIds.length > 0 && versionId) {
    const res = await getPool().query<{ id: string; prev_id: string | null; next_id: string | null }>(
      `WITH ordered AS (
         SELECT sv.snapshot_id AS id,
           LAG(sv.snapshot_id)  OVER (ORDER BY sv.sort_key) AS prev_id,
           LEAD(sv.snapshot_id) OVER (ORDER BY sv.sort_key) AS next_id
         FROM script_version sv WHERE sv.version_id = $1
       )
       SELECT id, prev_id, next_id FROM ordered WHERE id = ANY($2::text[])`,
      [versionId, deleteBlockIds]
    );
    for (const r of res.rows) blockAdj.set(r.id, { prevId: r.prev_id, nextId: r.next_id });
  }

  // ── Phase 2: main script transaction ─────────────────────────────────────
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const previousMarkerStructure = versionId && mayChangeMarkerStructure
      ? await markerStructureBlocksInTx(client, versionId)
      : [];

    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertScenes.map(s => s.id), productionId]
      );
      if (versionId) {
        await client.query(
          `INSERT INTO scene_version (scene_id, version_id, name, sort_order, parent_id)
           SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::text[])
           ON CONFLICT (scene_id, version_id) DO UPDATE
             SET name = EXCLUDED.name,
                 sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
          [upsertScenes.map(s => s.id), versionId,
           upsertScenes.map(s => s.name), upsertScenes.map(s => s.sortOrder),
           upsertScenes.map(s => s.parentId ?? null)]
        );
      } else {
        console.error(`[fallback] flushToDB: no active version for production ${productionId} — scene data lost (identity rows created, scene_version not written)`);
      }
    }

    if (upsertChars.length > 0) {
      await client.query(
        `INSERT INTO character (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertChars.map(c => c.id), productionId]
      );
      if (versionId) {
        await client.query(
          `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate)
           SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::bool[])
           ON CONFLICT (character_id, version_id) DO UPDATE
             SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_aggregate = EXCLUDED.is_aggregate`,
          [upsertChars.map(c => c.id), versionId,
           upsertChars.map(c => c.name), upsertChars.map(c => c.sortOrder),
           upsertChars.map(c => c.isAggregate)]
        );
      } else {
        console.error(`[fallback] flushToDB: no active version for production ${productionId} — character data lost (identity rows created, character_version not written)`);
      }
    }

    if (upsertBlocks.length > 0) {
      // Full upsert into script (using block id as snapshot id — legacy mode)
      await client.query(
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name, owner_marker_id)
         SELECT unnest($1::text[]), unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]),
                unnest($5::text[]), unnest($6::block_type[]), unnest($7::text[]), unnest($8::text[]),
                unnest($9::jsonb[]), unnest($10::bool[]), unnest($11::text[])
         ON CONFLICT (id) DO UPDATE SET
           block_id = EXCLUDED.block_id, sort_key = EXCLUDED.sort_key, scene_id = EXCLUDED.scene_id,
           rehearsal_mark = EXCLUDED.rehearsal_mark, owner_marker_id = EXCLUDED.owner_marker_id,
           type = EXCLUDED.type, content = EXCLUDED.content,
           stage_comment = EXCLUDED.stage_comment, marker_meta = EXCLUDED.marker_meta,
           force_show_character_name = EXCLUDED.force_show_character_name`,
        [
          upsertBlocks.map(b => b.id), productionId,
          upsertBlocks.map(b => b.lexKey), upsertBlocks.map(b => b.sceneId ?? null),
          upsertBlocks.map(b => b.rehearsalMark ?? null), upsertBlocks.map(b => toDbType(b)),
          upsertBlocks.map(b => b.content),
          upsertBlocks.map(b => b.stageComment?.trim() || null),
          upsertBlocks.map(b => markerMetaJson(b)),
          upsertBlocks.map(b => b.forceShowCharacterName ?? false),
          upsertBlocks.map(b => b.ownerMarkerId ?? null),
        ]
      );

      // Upsert version relation if we have a versionId
      if (versionId) {
        await client.query(
          `INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
           SELECT unnest($1::text[]), $2::text, unnest($1::text[]), unnest($3::text[])
           ON CONFLICT (snapshot_id, version_id) DO UPDATE SET sort_key = EXCLUDED.sort_key`,
          [upsertBlocks.map(b => b.id), versionId, upsertBlocks.map(b => b.lexKey)]
        );
      }

      await client.query(
        "DELETE FROM script_character WHERE script_id = ANY($1::text[])",
        [upsertBlocks.map(b => b.id)]
      );
      const scRows = upsertBlocks.flatMap(b =>
        b.characterIds.map((cid, pos) => ({ sid: b.id, cid, pos, ann: b.characterAnnotations[cid] ?? null }))
      );
      if (scRows.length > 0) {
        await client.query(
          `INSERT INTO script_character (script_id, character_id, position, annotation)
           SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
          [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)]
        );
      }
    }

    if (deleteBlockIds.length > 0) {
      if (versionId) {
        await client.query(
          `WITH removed AS (
             DELETE FROM script_version WHERE snapshot_id = ANY($1::text[]) AND version_id = $2 RETURNING snapshot_id
           )
           DELETE FROM script s WHERE s.id IN (SELECT snapshot_id FROM removed)
             AND NOT EXISTS (SELECT 1 FROM script_version sv2 WHERE sv2.snapshot_id = s.id)`,
          [deleteBlockIds, versionId]
        );
      } else {
        await client.query("DELETE FROM script WHERE id = ANY($1::text[])", [deleteBlockIds]);
      }
    }
    if (deleteCharIds.length > 0)
      await client.query("DELETE FROM character WHERE id = ANY($1::text[])", [deleteCharIds]);
    if (deleteSceneIds.length > 0)
      await client.query("DELETE FROM scene WHERE id = ANY($1::text[])", [deleteSceneIds]);

    if (versionId && mayChangeMarkerStructure) {
      await normalizeRehearsalMarkOwnershipInTx(client, versionId);
      const finalMarkerStructure = await markerStructureBlocksInTx(client, versionId);
      if (!sameMarkerStructure(previousMarkerStructure, finalMarkerStructure)) {
        await bumpMarkerStructureRevisionInTx(client, versionId);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ── Phase 3: cue drift adjustments (best-effort) ──────────────────────────
  if (versionId) {
    const driftJobs: Promise<void>[] = [];
    for (const blockId of deleteBlockIds) {
      const adj = blockAdj.get(blockId);
      if (adj) driftJobs.push(handleBlockDeleted(blockId, adj.prevId, adj.nextId, versionId));
    }
    for (const block of upsertBlocks) {
      const old = oldContents.get(block.id);
      if (old !== undefined && old !== block.content)
        driftJobs.push(handleBlockContentChanged(block.id, block.id, old, block.content, versionId));
    }
    if (driftJobs.length > 0) await Promise.allSettled(driftJobs);
  }
}

/**
 * Brute-force import: clears ALL blocks from a specific version and replaces them.
 * No copy-on-write, no cue drift — caller is responsible for choosing an editing version.
 * Scenes and characters are upserted at both the production level and the version level.
 */
export async function importScriptToVersion(
  productionId: string,
  versionId: string,
  payload: {
    upsertBlocks: Array<{
      id: string;
      blockId?: string;
      type: Block["type"];
      content: string;
      stageComment?: string | null;
      lyric: boolean;
      characterIds: string[];
      characterAnnotations: Record<string, string>;
      ownerMarkerId?: string | null;
      sceneId: string | null;
      rehearsalMark: string | null;
      markerMeta?: MarkerMeta | null;
      lexKey: string;
    }>;
    upsertChars: Array<{ id: string; name: string; isAggregate: boolean; sortOrder: number }>;
    upsertScenes: Array<{ id: string; number: string; name: string; parentId: string | null; sortOrder: number }>;
    upsertCueColumns?: Array<{
      name: string;
      cues: Array<{ afterBlockId: string | null; content: string }>;
    }>;
    cueListCreatedBy?: string;
    deleteSceneIds?: string[];
    blockTagAssignments?: Array<{ blockId: string; groupId: string; optionId: string }>;
    tagChanges?: ImportTagChanges;
    aggregateMembers?: Array<{ aggregateId: string; memberIds: string[] }>;
    openingChapter?: { markerId: string; show?: boolean };
    stageDelimiters?: { open: string; close: string };
    ensureEmptySceneBlocks?: boolean;
  },
): Promise<void> {
  // Marker projection operates on logical block IDs, while import IDs identify snapshots.
  const projectedBlocks = withLegacyOwnershipProjection(withMarkerOwnership(
    payload.upsertBlocks.map((block) => ({ ...block, id: block.blockId ?? block.id })),
  ));
  const upsertBlocks = projectedBlocks.map((block, index) => ({
    ...block,
    id: payload.upsertBlocks[index].id,
  }));
  const { deleteSceneIds = [] } = payload;
  const seenCharIds = new Set<string>();
  const upsertChars = payload.upsertChars.filter((char) => {
    if (seenCharIds.has(char.id)) return false;
    seenCharIds.add(char.id);
    return true;
  });
  const seenSceneIds = new Set<string>();
  const upsertScenes = payload.upsertScenes
    .filter((scene) => {
      if (seenSceneIds.has(scene.id)) return false;
      seenSceneIds.add(scene.id);
      return true;
    })
    .map((scene, sortOrder) => ({ ...scene, sortOrder }));
  const sceneAnchorIds = [...new Set([
    ...upsertScenes.map((scene) => scene.id),
    ...upsertBlocks.flatMap((block) => block.sceneId ? [block.sceneId] : []),
  ])];
  const upsertCueColumns = (payload.upsertCueColumns ?? [])
    .map((column) => ({
      name: column.name.trim(),
      cues: column.cues.filter((cue) => cue.content.trim()),
    }))
    .filter((column) => column.name && column.cues.length > 0);
  if (upsertCueColumns.length > 0 && !payload.cueListCreatedBy) {
    throw new Error("cueListCreatedBy is required when importing Cue columns");
  }
  const tagChanges = payload.tagChanges ?? { createGroups: [], createOptions: [], updateGroups: [], updateOptions: [], deleteGroupIds: [], deleteOptionIds: [] };
  const tagGroupUpdates = tagChanges.updateGroups ?? [];
  const aggregateMembers = payload.aggregateMembers ?? [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const previousMarkerStructure = await markerStructureBlocksInTx(client, versionId);

    const knownCharacterIds = new Set(upsertChars.map(character => character.id));
    const aggregateCharacterIds = [...new Set(aggregateMembers.flatMap(item => [item.aggregateId, ...item.memberIds]))];
    if (aggregateCharacterIds.length > 0) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM character WHERE production_id = $1 AND id = ANY($2::text[])",
        [productionId, aggregateCharacterIds],
      );
      for (const row of existing.rows) knownCharacterIds.add(row.id);
      const missingCharacterId = aggregateCharacterIds.find(id => !knownCharacterIds.has(id));
      if (missingCharacterId) throw new Error(`Imported aggregate character is missing: ${missingCharacterId}`);
    }

    const createdGroupIdByClientId = new Map<string, string>();
    const createdOptionIdByClientId = new Map<string, string>();
    if (tagChanges.deleteGroupIds.length > 0) {
      const owned = await client.query<{ id: string }>(
        "SELECT id FROM tag_group WHERE production_id = $1 AND id = ANY($2::text[])",
        [productionId, tagChanges.deleteGroupIds],
      );
      if (owned.rows.length !== new Set(tagChanges.deleteGroupIds).size) throw new Error("Tag group does not belong to the production");
    }
    if (tagChanges.deleteOptionIds.length > 0) {
      const owned = await client.query<{ id: string }>(
        `SELECT tag_option.id FROM tag_option
         JOIN tag_group ON tag_group.id = tag_option.group_id
         WHERE tag_group.production_id = $1 AND tag_option.id = ANY($2::text[])`,
        [productionId, tagChanges.deleteOptionIds],
      );
      if (owned.rows.length !== new Set(tagChanges.deleteOptionIds).size) throw new Error("Tag option does not belong to the production");
    }
    for (const group of tagChanges.createGroups) {
      const id = `tg${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      createdGroupIdByClientId.set(group.clientId, id);
      await client.query(
        "INSERT INTO tag_group (id, production_id, name, type, sort_order) VALUES ($1, $2, $3, 'exclusive', 0)",
        [id, productionId, group.name],
      );
    }
    for (const option of tagChanges.createOptions) {
      const groupId = createdGroupIdByClientId.get(option.groupId) ?? option.groupId;
      const group = await client.query("SELECT 1 FROM tag_group WHERE id = $1 AND production_id = $2", [groupId, productionId]);
      if (group.rowCount !== 1) throw new Error(`Tag option group is missing: ${option.groupId}`);
      const id = `to${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      createdOptionIdByClientId.set(option.clientId, id);
      await client.query(
        "INSERT INTO tag_option (id, group_id, label, color, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [id, groupId, option.label, option.color, option.sortOrder],
      );
    }
    for (const update of tagChanges.updateOptions ?? []) {
      const groupId = createdGroupIdByClientId.get(update.groupId) ?? update.groupId;
      const optionId = createdOptionIdByClientId.get(update.optionId) ?? update.optionId;
      const sets: string[] = [];
      const values: unknown[] = [];
      if (update.color !== undefined) {
        values.push(update.color);
        sets.push(`color = $${values.length}`);
      }
      if (update.sortOrder !== undefined) {
        values.push(update.sortOrder);
        sets.push(`sort_order = $${values.length}`);
      }
      if (sets.length === 0) continue;
      values.push(optionId, groupId, productionId);
      const updated = await client.query(
        `UPDATE tag_option
         SET ${sets.join(", ")}
         FROM tag_group
         WHERE tag_option.id = $${values.length - 2}
           AND tag_option.group_id = $${values.length - 1}
           AND tag_group.id = tag_option.group_id
           AND tag_group.production_id = $${values.length}`,
        values,
      );
      if (updated.rowCount !== 1) throw new Error(`Tag option is missing: ${update.optionId}`);
    }
    for (const update of tagGroupUpdates) {
      const groupId = createdGroupIdByClientId.get(update.groupId) ?? update.groupId;
      const lyricSplitAfterOptionId = update.lyricSplitAfterOptionId == null
        ? update.lyricSplitAfterOptionId
        : createdOptionIdByClientId.get(update.lyricSplitAfterOptionId) ?? update.lyricSplitAfterOptionId;
      const defaultOptionId = update.defaultOptionId == null
        ? update.defaultOptionId
        : createdOptionIdByClientId.get(update.defaultOptionId) ?? update.defaultOptionId;
      const group = await client.query(
        "SELECT 1 FROM tag_group WHERE id = $1 AND production_id = $2 AND type = 'exclusive'",
        [groupId, productionId],
      );
      if (group.rowCount !== 1) throw new Error(`Tag format group is missing: ${update.groupId}`);
      for (const [field, optionId] of [
        ["format", lyricSplitAfterOptionId],
        ["default", defaultOptionId],
      ] as const) {
        if (optionId === undefined || optionId === null) continue;
        const option = await client.query(
          "SELECT 1 FROM tag_option WHERE id = $1 AND group_id = $2",
          [optionId, groupId],
        );
        if (option.rowCount !== 1) throw new Error(`Tag ${field} option is missing: ${optionId}`);
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      if (update.lyricSplitAfterOptionId !== undefined) {
        values.push(lyricSplitAfterOptionId);
        sets.push(`lyric_split_after_option_id = $${values.length}`);
      }
      if (update.defaultOptionId !== undefined) {
        values.push(defaultOptionId);
        sets.push(`default_option_id = $${values.length}`);
      }
      if (sets.length > 0) {
        values.push(groupId);
        await client.query(`UPDATE tag_group SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
      }
    }
    if (tagChanges.deleteOptionIds.length > 0) {
      await client.query("DELETE FROM tag_option WHERE id = ANY($1::text[])", [tagChanges.deleteOptionIds]);
    }
    if (tagChanges.deleteGroupIds.length > 0) {
      await client.query("DELETE FROM tag_group WHERE id = ANY($1::text[])", [tagChanges.deleteGroupIds]);
    }
    const resolvedBlockTags = (payload.blockTagAssignments ?? []).map(tag => ({
      blockId: tag.blockId,
      groupId: createdGroupIdByClientId.get(tag.groupId) ?? tag.groupId,
      optionId: createdOptionIdByClientId.get(tag.optionId) ?? tag.optionId,
    }));
    const tagPairs = [...new Map(resolvedBlockTags.map(tag => [
      `${tag.groupId}:${tag.optionId}`,
      { groupId: tag.groupId, optionId: tag.optionId },
    ])).values()];
    if (tagPairs.length > 0) {
      const valid = await client.query<{ group_id: string; option_id: string }>(
        `SELECT requested.group_id, requested.option_id
         FROM unnest($2::text[], $3::text[]) AS requested(group_id, option_id)
         JOIN tag_group ON tag_group.id = requested.group_id AND tag_group.production_id = $1
         JOIN tag_option ON tag_option.id = requested.option_id AND tag_option.group_id = requested.group_id`,
        [
          productionId,
          tagPairs.map(tag => tag.groupId),
          tagPairs.map(tag => tag.optionId),
        ],
      );
      const validPairs = new Set(valid.rows.map(tag => `${tag.group_id}:${tag.option_id}`));
      const invalid = tagPairs.find(tag => !validPairs.has(`${tag.groupId}:${tag.optionId}`));
      if (invalid) throw new Error(`Imported Tag mapping is invalid: ${invalid.groupId}/${invalid.optionId}`);
    }

    // Clear all blocks from this version; GC snapshots no longer referenced by any version.
    // Split into three separate statements to avoid PostgreSQL CTE snapshot isolation:
    // a single statement's NOT EXISTS would see the pre-deletion state of the CTE rows.
    const removedSV = await client.query<{ snapshot_id: string; block_id: string }>(
      "DELETE FROM script_version WHERE version_id = $1 RETURNING snapshot_id, block_id",
      [versionId]
    );
    const removedSnapshotIds = removedSV.rows.map(r => r.snapshot_id);
    const removedBlockIds    = removedSV.rows.map(r => r.block_id);

    if (removedBlockIds.length > 0) {
      await client.query(
        `DELETE FROM block_tag WHERE block_id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM script_version sv WHERE sv.block_id = block_tag.block_id)`,
        [removedBlockIds]
      );
    }
    if (removedSnapshotIds.length > 0) {
      await client.query(
        `DELETE FROM script WHERE id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM script_version sv WHERE sv.snapshot_id = script.id)`,
        [removedSnapshotIds]
      );
    }

    // Clear cue bindings for this version; GC cue revision rows sole-referenced by it.
    // Anchors are soft references (no FK), so deleted snapshots leave no FK constraint.
    const removedCV = await client.query<{ revision_id: string }>(
      "DELETE FROM cue_version WHERE version_id = $1 RETURNING revision_id",
      [versionId]
    );
    const removedCueRevisionIds = removedCV.rows.map(r => r.revision_id);
    if (removedCueRevisionIds.length > 0) {
      await client.query(
        `DELETE FROM cue WHERE id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = cue.id)`,
        [removedCueRevisionIds]
      );
    }

    // Import is a full replacement of script + dramaturgy for this version.
    // scene_version is a derived read model over the markers; rebuild it below.
    await client.query("DELETE FROM scene_version WHERE version_id = $1", [versionId]);

    if (sceneAnchorIds.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [sceneAnchorIds, productionId]
      );
    }
    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene_version (scene_id, version_id, name, sort_order, parent_id)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::text[])
         ON CONFLICT (scene_id, version_id) DO UPDATE
           SET name = EXCLUDED.name,
               sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
        [upsertScenes.map(s => s.id), versionId,
          upsertScenes.map(s => s.name),
         upsertScenes.map(s => s.sortOrder), upsertScenes.map(s => s.parentId ?? null)]
      );
    }
    if (deleteSceneIds.length > 0) {
      await client.query(
        "DELETE FROM scene_version WHERE scene_id = ANY($1::text[]) AND version_id = $2",
        [deleteSceneIds, versionId]
      );
    }

    if (upsertChars.length > 0) {
      await client.query(
        `INSERT INTO character (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertChars.map(c => c.id), productionId]
      );
      await client.query(
        `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::bool[])
         ON CONFLICT (character_id, version_id) DO UPDATE
           SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_aggregate = EXCLUDED.is_aggregate`,
        [upsertChars.map(c => c.id), versionId,
         upsertChars.map(c => c.name), upsertChars.map(c => c.sortOrder),
         upsertChars.map(c => c.isAggregate)]
      );
    }

    if (upsertBlocks.length > 0) {
      await client.query(
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, force_show_character_name, marker_meta, owner_marker_id)
         SELECT unnest($1::text[]), unnest($10::text[]), $2::text, unnest($3::text[]),
                unnest($4::text[]), unnest($5::text[]), unnest($6::block_type[]), unnest($7::text[]),
                unnest($8::text[]), unnest($9::bool[]), unnest($11::jsonb[]), unnest($12::text[])`,
        [
          upsertBlocks.map(b => b.id), productionId,
          upsertBlocks.map(b => b.lexKey), upsertBlocks.map(b => b.sceneId ?? null),
          upsertBlocks.map(b => b.rehearsalMark ?? null),
          upsertBlocks.map(b => toDbType(b as Block)),
          upsertBlocks.map(b => b.content),
          upsertBlocks.map(b => b.stageComment?.trim() || null),
          upsertBlocks.map(() => false),
          upsertBlocks.map(b => b.blockId ?? b.id),
          upsertBlocks.map(b => markerMetaJson(b)),
          upsertBlocks.map(b => b.ownerMarkerId ?? null),
        ]
      );
      await client.query(
        `INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
         SELECT unnest($1::text[]), $2::text, unnest($4::text[]), unnest($3::text[])`,
        [
          upsertBlocks.map(b => b.id),
          versionId,
          upsertBlocks.map(b => b.lexKey),
          upsertBlocks.map(b => b.blockId ?? b.id),
        ]
      );
      const scRows = upsertBlocks.flatMap(b =>
        b.characterIds.map((cid, pos) => ({ sid: b.id, cid, pos, ann: b.characterAnnotations[cid] ?? null }))
      );
      if (scRows.length > 0) {
        await client.query(
          `INSERT INTO script_character (script_id, character_id, position, annotation)
           SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
          [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)]
        );
      }
    }

    if (upsertCueColumns.length > 0) {
      await importCueColumnsInTx(
        client,
        productionId,
        versionId,
        payload.cueListCreatedBy!,
        upsertCueColumns,
      );
    }

    if (aggregateMembers.length > 0) {
      const aggregateIds = [...new Set(aggregateMembers.map((membership) => membership.aggregateId))];
      await client.query("DELETE FROM character_aggregate WHERE aggregate_id = ANY($1::text[])", [aggregateIds]);
      const membershipRows = aggregateMembers.flatMap((membership) => (
        [...new Set(membership.memberIds)].map((memberId) => ({ aggregateId: membership.aggregateId, memberId }))
      ));
      if (membershipRows.length > 0) {
        await client.query(
          `INSERT INTO character_aggregate (aggregate_id, member_id)
           SELECT unnest($1::text[]), unnest($2::text[])`,
          [
            membershipRows.map((membership) => membership.aggregateId),
            membershipRows.map((membership) => membership.memberId),
          ],
        );
      }
    }

    const dedupedBlockTags = [...new Map(
      resolvedBlockTags.map(tag => [`${tag.blockId}:${tag.groupId}`, tag]),
    ).values()];
    if (dedupedBlockTags.length > 0) {
      await client.query(
        `INSERT INTO block_tag (block_id, group_id, option_id, updated_at)
         SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), now()
         ON CONFLICT (block_id, group_id) DO UPDATE
           SET option_id = EXCLUDED.option_id, updated_at = now()`,
        [
          dedupedBlockTags.map(tag => tag.blockId),
          dedupedBlockTags.map(tag => tag.groupId),
          dedupedBlockTags.map(tag => tag.optionId),
        ],
      );
    }

    if (payload.openingChapter) {
      const config = payload.openingChapter.show === undefined
        ? { openingChapterMarkerId: payload.openingChapter.markerId }
        : { openingChapterMarkerId: payload.openingChapter.markerId, showOpeningChapter: payload.openingChapter.show };
      await client.query(
        "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2 AND production_id = $3",
        [JSON.stringify(config), versionId, productionId],
      );
    }
    if (payload.stageDelimiters) {
      await client.query(
        "UPDATE production SET script_config = script_config || $1::jsonb WHERE id = $2",
        [JSON.stringify({ stageDelimOpen: payload.stageDelimiters.open, stageDelimClose: payload.stageDelimiters.close }), productionId],
      );
    }

    await normalizeRehearsalMarkOwnershipInTx(client, versionId);
    await syncSceneVersionsFromMarkersInTx(client, productionId, versionId);
    if (payload.ensureEmptySceneBlocks) {
      await ensureEmptyScriptBlocksForEmptyScenesInTx(client, productionId, versionId);
    }
    const finalMarkerStructure = await markerStructureBlocksInTx(client, versionId);
    if (!sameMarkerStructure(previousMarkerStructure, finalMarkerStructure)) {
      await bumpMarkerStructureRevisionInTx(client, versionId);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function ensureEmptyScriptBlocksForEmptyScenesInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
): Promise<void> {
  const res = await client.query<{
      block_id: string;
      sort_key: string;
      type: string;
      marker_meta: MarkerMeta | null;
    }>(
      `SELECT sv.block_id, sv.sort_key, s.type::text, s.marker_meta
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
       ORDER BY sv.sort_key`,
      [versionId],
  );

  const childSceneParentIds = new Set(
      res.rows
        .filter(row => row.type === "scene_marker" && row.marker_meta?.parentMarkerId)
        .map(row => row.marker_meta?.parentMarkerId)
        .filter((id): id is string => !!id),
  );
  const configRes = await client.query<{ opening_chapter_marker_id: string | null }>(
      "SELECT script_config->>'openingChapterMarkerId' AS opening_chapter_marker_id FROM version WHERE id = $1",
      [versionId],
  );
  const configuredOpeningChapterMarkerId = configRes.rows[0]?.opening_chapter_marker_id ?? null;
  const openingChapterMarkerId =
    configuredOpeningChapterMarkerId && res.rows.some(row => row.block_id === configuredOpeningChapterMarkerId && row.type === "chapter_marker")
      ? configuredOpeningChapterMarkerId
      : res.rows.find(row => row.type === "chapter_marker")?.block_id ?? null;

  const emptyBlocks: Array<{ snapshotId: string; blockId: string; sortKey: string; ownerMarkerId: string }> = [];
  for (let index = 0; index < res.rows.length; index++) {
    const row = res.rows[index];
    if (row.type !== "scene_marker" && row.type !== "chapter_marker") continue;
    if (row.block_id === openingChapterMarkerId) continue;
    if (row.type === "chapter_marker" && childSceneParentIds.has(row.block_id)) continue;

    let hasScriptBlock = false;
    for (let cursor = index + 1; cursor < res.rows.length; cursor++) {
      const next = res.rows[cursor];
      if (next.type === "chapter_marker" || next.type === "scene_marker") {
        break;
      }
      if (next.type === "dialogue" || next.type === "stage" || next.type === "lyric") {
        hasScriptBlock = true;
        break;
      }
    }
    if (hasScriptBlock) continue;

    const snapshotId = genSnapshotId();
    const blockId = `blk_${snapshotId}`;
    const nextSortKey = res.rows[index + 1]?.sort_key ?? null;
    const lexKey = keyBetween(row.sort_key, nextSortKey);
    emptyBlocks.push({ snapshotId, blockId, sortKey: lexKey, ownerMarkerId: row.block_id });
  }
  if (emptyBlocks.length > 0) {
    await client.query(
      `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, force_show_character_name, marker_meta, owner_marker_id)
       SELECT unnest($1::text[]), unnest($2::text[]), $3::text, unnest($4::text[]),
              NULL, NULL, 'dialogue'::block_type, '', NULL, false, '{}'::jsonb, unnest($5::text[])`,
      [
        emptyBlocks.map((block) => block.snapshotId),
        emptyBlocks.map((block) => block.blockId),
        productionId,
        emptyBlocks.map((block) => block.sortKey),
        emptyBlocks.map((block) => block.ownerMarkerId),
      ],
    );
    await client.query(
      `INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
       SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[])`,
      [
        emptyBlocks.map((block) => block.snapshotId),
        versionId,
        emptyBlocks.map((block) => block.blockId),
        emptyBlocks.map((block) => block.sortKey),
      ],
    );
  }
}

// ─── Production management ────────────────────────────────────────────────────

/** 建项目配额超限（事务内硬上限命中）。路由层捕获后转 403。 */
export class ProductionQuotaError extends Error {
  constructor(public readonly maxOwned: number) {
    super(`production quota exceeded (max ${maxOwned})`);
    this.name = "ProductionQuotaError";
  }
}

export async function createProduction(
  id: string,
  name: string,
  /** 必填：production.owner_id NOT NULL，且 owner 是 M-14(c) 责任链的终点，不允许无主演出。 */
  ownerUserId: string,
  productionType?: string,
  productionTypeLabel?: string | null,
  /** 初始项目档位（#280）：free 时不落行（production_plan 无行 = free），高于 free
   *  （internal owner 建项即最高档）与本体同事务落行。档位决策在路由层（lib/account/plan.ts）。 */
  initialPlan?: { tier: string; source: string },
  /** 配额硬上限（#307 review finding 1）：路由层的 count 预检是 TOCTOU 软门，这里在
   *  事务内锁 owner 的 user_plan 行串行化同 owner 并发建项，锁内重数超限抛
   *  ProductionQuotaError。Infinity 档（internal）不传即可。 */
  quota?: { maxOwned: number },
): Promise<void> {
  // 建项目全程一个事务：production 行、owner 的成员行、初始 version、模版灌入，
  // 要么全成要么全不成。以前是三段各自提交（裸 pool.query + createInitialVersion 自己
  // 一个事务 + 模版自己一个事务），中途抛错就在库里留一个没有 version、没有模版的半成品
  // 项目——路由 catch 后回 500，用户以为没建成，项目却还在。以前这种残骸只有 admin
  // 的全量列表看得见，创建放开（#281）+ owner 可见（#282）之后它会直接出现在建项目
  // 的人自己的列表里，必须一次做干净。
  const { applyProductionTemplate } = await import("./production/production-template");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (quota && Number.isFinite(quota.maxOwned)) {
      // 建项目门保证 creator 必有 user_plan 行；锁它让同 owner 的并发创建排队，
      // 排到的事务在锁内重新 count（READ COMMITTED 每语句新快照，看得见前一个的提交）。
      await client.query("SELECT 1 FROM user_plan WHERE user_id = $1 FOR UPDATE", [ownerUserId]);
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM production WHERE owner_id = $1 AND archived_at IS NULL",
        [ownerUserId],
      );
      if (Number(rows[0].n) >= quota.maxOwned) throw new ProductionQuotaError(quota.maxOwned);
    }
    await client.query(
      "INSERT INTO production (id, name, owner_id, type, type_label, script_config) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
      [
        id,
        name,
        ownerUserId,
        productionType ?? null,
        productionTypeLabel ?? null,
        JSON.stringify({ useRehearsalMarks: usesRehearsalMarksByDefault(productionType) }),
      ],
    );
    // owner 同时落一行 production_member：建项目的人当然在项目里。不给 roles——owner 的
    // 权限走 isOwner 旁路（见 hasEffectiveGrant 族与 requireAdminAccess），这行只管「在不在
    // 项目里」，不碰自动授权。以前建项目的人恒是 admin（列表走全量分支），少这行看不出来；
    // 创建放开后（#281）owner 建完就从自己的项目列表里消失了。
    await client.query(
      "INSERT INTO production_member (production_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [id, ownerUserId],
    );
    if (initialPlan && initialPlan.tier !== "free") {
      await client.query(
        "INSERT INTO production_plan (production_id, tier, source) VALUES ($1, $2, $3)",
        [id, initialPlan.tier, initialPlan.source],
      );
    }
    await createInitialVersion(id, client);
    // 主本（#336 B2）：版式住在 script_view 行上，建项即带一条，缺省 a4/center。
    await createMasterScriptView(id, client);
    // 建项目的全部初始状态——角色名单、部门树、部门静态区间键、cue 模版体系的初始行、
    // 策略档位、审批 TTL——统一由项目模版按类型灌入。
    // 见 lib/production/production-template.ts（模版是代码常量：改它＝改代码＝走 PR）。
    await applyProductionTemplate(id, productionType ?? null, client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Returns cue_type keys the user is allowed to create in a production, via dept membership. */
export async function getUserAllowedCueTypes(userId: string, productionId: string): Promise<string[]> {
  // §3.5：改读声明表 can_create 路径（原 production_dept.allowed_cue_types 数组已迁移）
  const { listCreatableTemplates } = await import("./ops/cue-template-db");
  return listCreatableTemplates(userId, productionId);
}

export async function deleteProduction(id: string): Promise<void> {
  await getPool().query("DELETE FROM production WHERE id = $1", [id]);
}

export type ProductionListEntry = {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  sortOrder: number;
  description: string;
  avatarUrl: string | null;
  type: string | null;
  typeLabel: string | null;
  language: string | null;
};

type ProductionRow = {
  id: string;
  name: string;
  created_at: Date;
  archived_at: Date | null;
  sort_order: number;
  description: string;
  avatar_url: string | null;
  type: string | null;
  type_label: string | null;
  language: string | null;
};

function mapProductionRow(r: ProductionRow): ProductionListEntry {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
    sortOrder: r.sort_order,
    description: r.description,
    avatarUrl: r.avatar_url ?? null,
    type: r.type ?? null,
    typeLabel: r.type_label ?? null,
    language: r.language ?? null,
  };
}

const PROD_COLS = "id, name, created_at, archived_at, sort_order, description, avatar_url, type, type_label, language";
const PROD_COLS_P = "p.id, p.name, p.created_at, p.archived_at, p.sort_order, p.description, p.avatar_url, p.type, p.type_label, p.language";

export async function listProductions(opts: { userId: string; isAdmin: boolean }): Promise<ProductionListEntry[]> {
  const orderBy = "CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, sort_order ASC, created_at ASC";
  let res;
  if (opts.isAdmin) {
    res = await getPool().query<ProductionRow>(
      `SELECT ${PROD_COLS} FROM production ORDER BY ${orderBy}`
    );
  } else {
    // owner 单列一条可见路径：owner 不必是成员（getProductionPermissionContext 就是
    // isAdmin/isOwner/isMember 三取一），内连接 production_member 会把「owner 但没有成员行」
    // 的项目整个藏掉。LEFT JOIN + OR owner_id 才与权限判定同口径。
    res = await getPool().query<ProductionRow>(
      `SELECT ${PROD_COLS_P} FROM production p
       LEFT JOIN production_member pm ON pm.production_id = p.id AND pm.user_id = $1
       WHERE pm.user_id IS NOT NULL OR p.owner_id = $1
       ORDER BY ${orderBy}`,
      [opts.userId]
    );
  }
  return res.rows.map(mapProductionRow);
}

export type MyProductionEntry = {
  id: string; name: string; createdAt: string; archivedAt: string | null;
  sortOrder: number; roles: string[]; firstTag: string | null; avatarUrl: string | null;
  isOwner: boolean;
  hasAdminPerm: boolean; // true if FK-backed role 区间含治理域节点键（ADMIN_PANEL_NODE_PREFIXES）
  planTier: ProductionTier; // 项目付费档位（#280）：无 production_plan 行 = free
};

export async function listMyProductionsWithRoles(
  userId: string, isAdmin: boolean,
  adminPanelPrefixes: readonly string[],
): Promise<MyProductionEntry[]> {
  const orderBy = "CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END, p.sort_order ASC, p.created_at ASC";
  const res = await getPool().query<{
    id: string; name: string; created_at: Date; archived_at: Date | null;
    sort_order: number; roles: string[] | null; first_tag: string | null;
    avatar_url: string | null; is_owner: boolean; has_admin_perm: boolean;
    plan_tier: string | null;
  }>(
    `SELECT p.id, p.name, p.created_at, p.archived_at, p.sort_order, p.avatar_url,
            pm.roles, ppl.tier AS plan_tier,
            (
              SELECT pmt.name
              FROM production_member_tag_assignment pmta
              JOIN production_member_tag pmt ON pmt.id = pmta.tag_id
              WHERE pmta.production_id = p.id AND pmta.user_id = $1
              ORDER BY pmt.is_system DESC, pmt.name
              LIMIT 1
            ) AS first_tag,
            (p.owner_id = $1) AS is_owner,
            EXISTS(
              SELECT 1
              FROM production_member_role pmr
              JOIN production_role_permission prp ON prp.role_id = pmr.role_id
              WHERE pmr.production_id = p.id
                AND pmr.user_id = $1
                AND prp.permission_key LIKE ANY($3::text[])
            ) AS has_admin_perm
     FROM production p
     LEFT JOIN production_member pm
            ON pm.production_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
     LEFT JOIN production_plan ppl ON ppl.production_id = p.id
     -- 在职口径（#141）：退出/被停用之后这个项目就不该再出现在「我的项目」里，
     -- 否则点进去只会撞 403。owner 分支不受影响。
     WHERE ($2 OR pm.user_id IS NOT NULL OR p.owner_id = $1)
     ORDER BY ${orderBy}`,
    [userId, isAdmin, adminPanelPrefixes.map((p) => `${p}%`)],
  );
  return res.rows.map(r => ({
    id: r.id, name: r.name,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
    sortOrder: r.sort_order,
    roles: r.roles ?? [],
    firstTag: r.first_tag ?? null,
    avatarUrl: r.avatar_url ?? null,
    isOwner: r.is_owner,
    hasAdminPerm: r.has_admin_perm,
    planTier: normalizeProductionTier(r.plan_tier),
  }));
}

export async function updateProductionSortOrders(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE production SET sort_order = v.sort_order
       FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::int[]) AS sort_order) AS v
       WHERE production.id = v.id`,
      [orderedIds, orderedIds.map((_, i) => i + 1)]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── Auth / users ─────────────────────────────────────────────────────────────

/**
 * Upsert a Feishu user after OAuth login. Creates an app_user row for new
 * users; updates profile fields for returning users. Returns the internal userId.
 */

/** Look up the Feishu open_id for an internal user — used by Feishu-specific subsystems. */
export async function getFeishuOpenId(userId: string): Promise<string | null> {
  const res = await getPool().query<{ open_id: string }>(
    "SELECT open_id FROM feishu_user WHERE user_id = $1",
    [userId],
  );
  return res.rows[0]?.open_id ?? null;
}

export async function batchGetFeishuOpenIds(userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const res = await getPool().query<{ user_id: string; open_id: string }>(
    "SELECT user_id, open_id FROM feishu_user WHERE user_id = ANY($1)",
    [userIds],
  );
  return new Map(res.rows.map(r => [r.user_id, r.open_id]));
}

// ─── user_profile ──────────────────────────────────────────────────────────────

export async function upsertUserProfile(
  userId: string,
  name: string,
  avatarUrl: string | null,
  extra?: { displayName?: string | null; bio?: string | null; preferredPlatform?: string | null },
): Promise<void> {
  const sets: string[] = ["name = EXCLUDED.name", "avatar_url = EXCLUDED.avatar_url", "updated_at = now()"];
  const vals: unknown[] = [userId, name, avatarUrl];
  if (extra?.displayName !== undefined) { sets.push(`display_name = $${vals.push(extra.displayName)}`); }
  if (extra?.bio !== undefined) { sets.push(`bio = $${vals.push(extra.bio)}`); }
  if (extra?.preferredPlatform !== undefined) { sets.push(`preferred_platform = $${vals.push(extra.preferredPlatform)}`); }
  await getPool().query(
    `INSERT INTO user_profile (user_id, name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET ${sets.join(", ")}`,
    vals,
  );
}

// Upsert or clear the global notification_preference for a user.
// Called whenever the user changes their preferred_platform in profile settings.
export async function syncGlobalNotificationPreference(
  userId: string,
  platformId: string | null,
): Promise<void> {
  const pool = getPool();
  if (!platformId) {
    await pool.query(
      `DELETE FROM notification_preference WHERE user_id = $1 AND scope_type = 'global' AND scope_id = ''`,
      [userId],
    );
    return;
  }
  const upiRes = await pool.query<{ id: string }>(
    `SELECT id FROM user_platform_identity WHERE user_id = $1 AND platform_id = $2 LIMIT 1`,
    [userId, platformId],
  );
  const upiId = upiRes.rows[0]?.id;
  if (!upiId) return; // platform not bound yet — silently skip
  await pool.query(
    `INSERT INTO notification_preference (user_id, scope_type, scope_id, platform_identity_id)
     VALUES ($1, 'global', '', $2)
     ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET platform_identity_id = EXCLUDED.platform_identity_id`,
    [userId, upiId],
  );
}

/** 用户邮箱：email identity 任一（primary 优先——未设 primary 也要尽量给出邮箱，
 *  水印/溯源场景宁可有）→ feishu_user.email fallback。 */
export async function getUserPrimaryEmail(userId: string): Promise<string | null> {
  const res = await getPool().query<{ email: string | null }>(
    `SELECT COALESCE(
       (SELECT upi.platform_user_id FROM user_platform_identity upi
        WHERE upi.user_id = $1 AND upi.platform_id = 'email'
        ORDER BY upi.is_primary DESC, upi.created_at DESC LIMIT 1),
       (SELECT fu.email FROM feishu_user fu WHERE fu.user_id = $1)
     ) AS email`,
    [userId],
  );
  return res.rows[0]?.email ?? null;
}

export async function getUserProfile(
  userId: string,
): Promise<{ name: string; displayName: string | null; bio: string | null; preferredPlatform: string | null; avatarUrl: string | null; isAdmin: boolean } | null> {
  const res = await getPool().query<{ name: string; display_name: string | null; bio: string | null; preferred_platform: string | null; avatar_url: string | null; is_super_admin: boolean | null }>(
    `SELECT up.name, up.display_name, up.bio, up.preferred_platform, up.avatar_url, fu.is_super_admin
     FROM user_profile up
     LEFT JOIN feishu_user fu ON fu.user_id = up.user_id
     WHERE up.user_id = $1`,
    [userId],
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    name: r.name,
    displayName: r.display_name,
    bio: r.bio,
    preferredPlatform: r.preferred_platform,
    avatarUrl: r.avatar_url,
    isAdmin: r.is_super_admin ?? false,
  };
}

export async function getUserIdentities(
  userId: string,
): Promise<{ id: string; platformId: string; platformUserId: string; label: string | null; isLoginMethod: boolean; isPrimary: boolean; displayName: string | null; avatarUrl: string | null }[]> {
  const res = await getPool().query<{
    id: string; platform_id: string; platform_user_id: string; label: string | null;
    is_login_method: boolean; is_primary: boolean; fu_name: string | null; fu_avatar: string | null;
  }>(
    `SELECT upi.id, upi.platform_id, upi.platform_user_id, upi.label, upi.is_login_method, upi.is_primary,
            fu.name AS fu_name, fu.avatar_url AS fu_avatar
     FROM user_platform_identity upi
     LEFT JOIN feishu_user fu ON fu.user_id = upi.user_id AND upi.platform_id = 'feishu'
     WHERE upi.user_id = $1
     ORDER BY upi.platform_id, upi.is_primary DESC, upi.created_at`,
    [userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    platformId: r.platform_id,
    platformUserId: r.platform_user_id,
    label: r.label,
    isLoginMethod: r.is_login_method,
    isPrimary: r.is_primary,
    displayName: r.fu_name ?? null,
    avatarUrl: r.fu_avatar ?? null,
  }));
}

export async function getUserByPlatformIdentity(
  platformId: string,
  platformUserId: string,
): Promise<string | null> {
  const res = await getPool().query<{ user_id: string }>(
    "SELECT user_id FROM user_platform_identity WHERE platform_id = $1 AND platform_user_id = $2",
    [platformId, platformUserId],
  );
  return res.rows[0]?.user_id ?? null;
}

// Add a new platform identity to an existing user. Returns 'bound' or 'conflict' (identity already belongs to a DIFFERENT user).
export async function bindPlatformIdentity(
  userId: string,
  platformId: string,
  platformUserId: string,
): Promise<{ result: "bound" } | { result: "conflict"; existingUserId: string }> {
  const pool = getPool();
  const existing = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM user_platform_identity WHERE platform_id = $1 AND platform_user_id = $2",
    [platformId, platformUserId],
  );
  if (existing.rows.length > 0) {
    const existingUserId = existing.rows[0].user_id;
    if (existingUserId === userId) return { result: "bound" }; // already bound
    return { result: "conflict", existingUserId };
  }
  if (platformId === "email") {
    const hasPrimary = await pool.query(
      `SELECT 1 FROM user_platform_identity WHERE user_id = $1 AND platform_id = 'email' AND is_primary = true`,
      [userId],
    );
    await pool.query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, $2, $3, true, $4)`,
      [userId, platformId, platformUserId, hasPrimary.rows.length === 0],
    );
  } else {
    await pool.query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method)
       VALUES ($1, $2, $3, true)`,
      [userId, platformId, platformUserId],
    );
  }
  return { result: "bound" };
}

export async function setPrimaryEmail(userId: string, upiId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Verify the target UPI belongs to this user and is an email identity
    const check = await client.query<{ id: string }>(
      `SELECT id FROM user_platform_identity WHERE id = $1 AND user_id = $2 AND platform_id = 'email'`,
      [upiId, userId],
    );
    if (!check.rows.length) throw new Error("identity not found");
    await client.query(
      `UPDATE user_platform_identity SET is_primary = false WHERE user_id = $1 AND platform_id = 'email'`,
      [userId],
    );
    await client.query(
      `UPDATE user_platform_identity SET is_primary = true WHERE id = $1`,
      [upiId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function unbindEmail(userId: string, upiId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upi = await client.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM user_platform_identity WHERE id = $1 AND user_id = $2 AND platform_id = 'email'`,
      [upiId, userId],
    );
    if (!upi.rows.length) throw new Error("identity not found");

    // Count remaining login methods after removal
    const remaining = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_platform_identity WHERE user_id = $1 AND id != $2 AND is_login_method = true`,
      [userId, upiId],
    );
    if (Number(remaining.rows[0].count) === 0) throw new Error("last login method");

    // If removing primary and other emails exist, auto-promote the oldest other email
    if (upi.rows[0].is_primary) {
      await client.query(
        `UPDATE user_platform_identity SET is_primary = true
         WHERE id = (
           SELECT id FROM user_platform_identity
           WHERE user_id = $1 AND platform_id = 'email' AND id != $2
           ORDER BY created_at ASC LIMIT 1
         )`,
        [userId, upiId],
      );
    }

    await client.query(`DELETE FROM user_platform_identity WHERE id = $1`, [upiId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface AccountSummary {
  userId: string;
  name: string | null;
  identities: { platformId: string; label: string | null }[];
  productionCount: number;
}

export async function getAccountSummary(userId: string): Promise<AccountSummary | null> {
  const pool = getPool();
  const [nameRow, idRows, countRow] = await Promise.all([
    pool.query<{ name: string | null }>(
      `SELECT name FROM user_profile WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ platform_id: string; label: string | null; fu_name: string | null }>(
      `SELECT upi.platform_id,
              upi.label,
              fu.name AS fu_name
         FROM user_platform_identity upi
         LEFT JOIN feishu_user fu ON fu.user_id = upi.user_id AND upi.platform_id = 'feishu'
        WHERE upi.user_id = $1`,
      [userId],
    ),
    pool.query<{ count: string }>(
      // 「参与 N 个项目」——在职口径。离组/停用的不计。
      `SELECT COUNT(*)::text AS count FROM production_member
        WHERE user_id = $1 AND status = 'active'`,
      [userId],
    ),
  ]);
  if (nameRow.rows.length === 0 && idRows.rows.length === 0) return null;
  return {
    userId,
    name: nameRow.rows[0]?.name ?? null,
    identities: idRows.rows.map(r => ({
      platformId: r.platform_id,
      label: r.fu_name ?? r.label,
    })),
    productionCount: parseInt(countRow.rows[0]?.count ?? "0", 10),
  };
}

export async function getSharedProductions(
  userId1: string,
  userId2: string,
): Promise<{ id: string; name: string }[]> {
  const res = await getPool().query<{ id: string; name: string }>(
    `SELECT p.id, p.name
       FROM production_member pm1
       JOIN production_member pm2 ON pm1.production_id = pm2.production_id
       JOIN production p ON p.id = pm1.production_id
      WHERE pm1.user_id = $1 AND pm2.user_id = $2
        AND pm1.status = 'active' AND pm2.status = 'active'`,
    [userId1, userId2],
  );
  return res.rows;
}

// Merge deleteUserId INTO keepUserId.
// Precondition: no shared productions (call getSharedProductions first).
// Transfers all user-linked data. Non-CASCADE FKs are updated before deletion.
export async function mergeAccounts(keepUserId: string, deleteUserId: string): Promise<void> {
  if (keepUserId === deleteUserId) return;

  const shared = await getSharedProductions(keepUserId, deleteUserId);
  if (shared.length > 0) {
    throw new Error(`Cannot merge: both accounts are in ${shared.map(p => p.name).join(", ")}`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update RESTRICT (non-CASCADE) FKs — must happen before DELETE
    await client.query(`UPDATE cue_list SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE production_event SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    // report/note 作者已随 wiki-split 迁入 wiki.created_by
    await client.query(`UPDATE wiki SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE wiki_revision SET author_user_id = $1 WHERE author_user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE asset SET uploader_user_id = $1 WHERE uploader_user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE node_mount SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE node SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    // asset_share_token 化石表已删（#420）：分享 token 是无状态 HMAC，无行可搬
    // production_member_status_audit.actor_id 是 NO ACTION 的 FK（#141）：漏了这条，
    // 任何处置过别人成员状态的账号都无法被合并——DELETE app_user 直接撞 FK 违例。
    await client.query(
      `UPDATE production_member_status_audit SET actor_id = $1 WHERE actor_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 2. Transfer production memberships (safe: no shared productions)
    await client.query(
      // status 三列必须一并搬（#141）：漏了的话 DEFAULT 'active' 会把一个 suspended
      // 或 exited 的成员在合并账号时悄悄复活成在职，而且不留任何审计行。
      `INSERT INTO production_member
         (production_id, user_id, roles, photo_url, added_at,
          status, status_source, status_changed_at, status_changed_by)
       SELECT production_id, $1, roles, photo_url, added_at,
              status, status_source, status_changed_at, status_changed_by
         FROM production_member WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM production_member WHERE user_id = $1`, [deleteUserId]);
    // 状态轨迹跟着身份走。user_id 是 ON DELETE CASCADE，不改指向的话下面删旧
    // app_user 时整条轨迹会被静默级联删掉——合并账号成了抹痕迹的第二条路。
    await client.query(
      `UPDATE production_member_status_audit SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );
    await client.query(
      `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
       SELECT production_id, $1, permission, granted FROM production_member_permission WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM production_member_permission WHERE user_id = $1`, [deleteUserId]);

    // 3. Transfer event-scoped data (no shared productions → no PK conflicts)
    await client.query(`UPDATE event_call_time SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(
      `INSERT INTO event_participant (id, event_id, user_id, name, department_id, role)
       SELECT id, event_id, $1, name, department_id, role FROM event_participant WHERE user_id = $2
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM event_participant WHERE user_id = $1`, [deleteUserId]);
    await client.query(
      `UPDATE production_dept_member pdm SET user_id = $1 WHERE user_id = $2
       AND NOT EXISTS (SELECT 1 FROM production_dept_member p2 WHERE p2.user_id = $1 AND p2.dept_id = pdm.dept_id)`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM production_dept_member WHERE user_id = $1`, [deleteUserId]);
    await client.query(`UPDATE event_stage_manager SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE schedule_item_participant SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE task_assignee SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE event_report_read SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE wiki_comment SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE comment SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    // Transfer cue list production_member_grant rows (cue_list_permission/role tables dropped in Phase 4)
    await client.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by, is_revoked, revoked_reason, expires_at)
       SELECT production_id, $1, resource_type, resource_id, resource_sub,
              permission_level, grant_source, confirmed_by, is_revoked, revoked_reason, expires_at
       FROM production_member_grant
       WHERE user_id = $2 AND resource_type = 'cue_list'
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(
      `DELETE FROM production_member_grant WHERE user_id = $1 AND resource_type = 'cue_list'`,
      [deleteUserId],
    );

    // 4. Transfer platform identities (before notification_preference, which FK-references them)
    await client.query(
      `UPDATE user_platform_identity SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 5. Transfer notification settings (may conflict regardless of productions)
    await client.query(
      `INSERT INTO notification_preference (user_id, scope_type, scope_id, platform_identity_id)
       SELECT $1, scope_type, scope_id, platform_identity_id FROM notification_preference WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM notification_preference WHERE user_id = $1`, [deleteUserId]);
    await client.query(
      `INSERT INTO notification_subscription (user_id, notification_type, enabled, updated_at)
       SELECT $1, notification_type, enabled, updated_at FROM notification_subscription WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM notification_subscription WHERE user_id = $1`, [deleteUserId]);

    // 6. Transfer feishu_user (keep keepUserId's row if both exist)
    await client.query(
      `DELETE FROM feishu_user WHERE user_id = $1
         AND EXISTS (SELECT 1 FROM feishu_user WHERE user_id = $2)`,
      [deleteUserId, keepUserId],
    );
    await client.query(
      `UPDATE feishu_user SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 7. Transfer notifications
    await client.query(
      `UPDATE user_notification SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 8. Delete old profile then user (CASCADE handles email_otp and any remaining rows)
    await client.query(`DELETE FROM user_profile WHERE user_id = $1`, [deleteUserId]);
    await client.query(`DELETE FROM app_user WHERE id = $1`, [deleteUserId]);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── Email OTP ────────────────────────────────────────────────────────────────

export async function createEmailOtp(userId: string, email: string, code: string, ttlMs: number): Promise<void> {
  await getPool().query(
    `INSERT INTO email_otp (user_id, email, code, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`,
    [userId, email, code, `${ttlMs} milliseconds`],
  );
}

// Consume an OTP: marks it used and returns the userId, or null if invalid/expired.
export async function consumeEmailOtp(email: string, code: string): Promise<string | null> {
  const res = await getPool().query<{ user_id: string }>(
    `UPDATE email_otp
     SET used_at = now()
     WHERE email = $1 AND code = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [email, code],
  );
  return res.rows[0]?.user_id ?? null;
}

export async function upsertEmailUser(
  email: string,
  name: string,
  /** 注册邀请制（lib/account/registration-gate.ts）：正当性是邀请码时传入，在建号事务内
   *  锁行消耗 + 落流水；并发用尽则整个事务回滚，不产生账号。老用户路径不触码。 */
  registrationCode?: string,
): Promise<{ userId: string }> {
  // 防御性归一（review #308 finding 1）：email 身份全库约定存小写（两个写点的
  // 路由各自 lower 过），在唯一的账号创建入口把不变量收为本地——大小写变体
  // 不可能绕过注册门检查或裂出重复账号。
  email = email.trim().toLowerCase();
  const { consumeRegistrationCode } = await import("./account/registration-gate");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = $1",
      [email],
    );
    let userId: string;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].user_id;
    } else {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO app_user DEFAULT VALUES RETURNING id",
      );
      userId = rows[0].id;
      await client.query(
        `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
         VALUES ($1, 'email', $2, true, true)`,
        [userId, email],
      );
      await client.query(
        `INSERT INTO user_profile (user_id, name) VALUES ($1, $2)`,
        [userId, name],
      );
      if (registrationCode) {
        await consumeRegistrationCode(client, registrationCode, userId, email);
      }
    }
    await client.query("COMMIT");
    return { userId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}


// getProductionMemberRoles 已删（#141）：全库零调用，而它返回的是不带 status 闸门
// 的成员判定——留着迟早有人拿它绕开闸门。成员判定的唯一入口是
// getProductionPermissionContext。

export async function setPermissionOverride(
  productionId: string,
  userId: string,
  permission: AtomicPermission,
  granted: boolean | null,
): Promise<void> {
  if (granted === null) {
    await getPool().query(
      "DELETE FROM production_member_permission WHERE production_id = $1 AND user_id = $2 AND permission = $3",
      [productionId, userId, permission],
    );
  } else {
    await getPool().query(
      `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (production_id, user_id, permission) DO UPDATE SET granted = EXCLUDED.granted`,
      [productionId, userId, permission, granted],
    );
  }
}

/** Bulk-load all overrides for all members in a production (for the management UI). */
export async function getAllPermissionOverrides(
  productionId: string,
): Promise<Record<string, Record<string, boolean>>> {
  const res = await getPool().query<{ user_id: string; permission: string; granted: boolean }>(
    "SELECT user_id, permission, granted FROM production_member_permission WHERE production_id = $1",
    [productionId],
  );
  const result: Record<string, Record<string, boolean>> = {};
  for (const row of res.rows) {
    result[row.user_id] ??= {};
    result[row.user_id][row.permission] = row.granted;
  }
  return result;
}

/**
 * New permission context for the atomic permission system.
 * Queries production_role_permission via role name JOIN; falls back to static
 * templates from lib/perm/permissions.ts when the production has no role records yet.
 * Also returns department membership for hasScopedPermission dept checks.
 */
export async function getProductionPermissionContext(
  userId: string,
  isAdmin: boolean,
  productionId: string,
): Promise<ProductionAccess | null> {
  const pool = getPool();

  const [memberRow, dbPermsRow, deptRow, productionRow] = await Promise.all([
    // Is user a member? And what are their role strings?
    //
    // status = 'active' 是访问闸门（#141）。suspended / exited 的成员行还在——
    // 名册要显示他们、历史要留痕、复职要零重配——但他们进不来。这一条不加，
    // 「停用」就只是名册上的一条删除线：人照样拿角色权限、部门权限与 resource grant。
    // 注意闸门只管 isMember：owner 走下面的 isOwner 分支，不受影响（owner 退出
    // 必须先转移 owner，见 #141）。
    pool.query<{ roles: string[] }>(
      "SELECT roles FROM production_member WHERE user_id = $1 AND production_id = $2 AND status = 'active'",
      [userId, productionId],
    ),
    // Try FK-backed permissions first (production_member_role populated after migration/setMemberRoles)
    pool.query<{ permission_key: string }>(
      `SELECT DISTINCT prp.permission_key
       FROM production_member_role pmr
       JOIN production_role_permission prp ON prp.role_id = pmr.role_id
       WHERE pmr.user_id = $1 AND pmr.production_id = $2`,
      [userId, productionId],
    ),
    // Department memberships（并表后单一 production_dept 数据源）
    pool.query<{ dept_id: string; is_poc: boolean }>(
      `SELECT pdm.dept_id, pdm.is_poc
       FROM production_dept_member pdm
       WHERE pdm.user_id = $1 AND pdm.production_id = $2`,
      [userId, productionId],
    ),
    pool.query<{ archived_at: Date | null; owner_id: string | null }>(
      "SELECT archived_at, owner_id FROM production WHERE id = $1",
      [productionId],
    ),
  ]);

  const prodRow = productionRow.rows[0];
  const isOwner = prodRow?.owner_id != null && prodRow.owner_id === userId;

  const isMember = memberRow.rows.length > 0;
  if (!isAdmin && !isOwner && !isMember) return null;

  let memberPermissions: Set<AtomicPermission> | null = null;

  if (isMember) {
    if (dbPermsRow.rows.length > 0) {
      // DB records exist: use exactly what's in production_role_permission.
      // Base permissions are now stored in role rows (db/add-base-perms-to-roles.sql, #158),
      // so no need to inject MEMBER_BASE_PERMISSIONS here.
      memberPermissions = new Set(
        dbPermsRow.rows.map((r) => r.permission_key as AtomicPermission),
      );
    } else {
      // 终局：代码模板已退役，无 FK 行 = 空区间
      memberPermissions = new Set();
    }
  }

  // overrides is reserved for future owner-granted direct permissions (Phase 7).
  const overrides = new Map<AtomicPermission, boolean>();

  const deptIds: string[] = [];
  const pocDeptIds: string[] = [];
  for (const row of deptRow.rows) {
    deptIds.push(row.dept_id);
    if (row.is_poc) pocDeptIds.push(row.dept_id);
  }

  // 终局（批G G-2）：区间三表经六步链消费、行经 hasGrant 消费——ctx 历史字段恒空
  const deptFreeApprovalZone = new Set<string>();
  const activeGrants = new Set<string>();

  return {
    permCtx: { userId, isAdmin, isOwner, memberPermissions, overrides, deptIds, pocDeptIds, deptFreeApprovalZone, activeGrants },
    isArchived: prodRow?.archived_at != null,
  };
}

export async function isProductionArchived(productionId: string): Promise<boolean> {
  const res = await getPool().query<{ archived_at: Date | null }>(
    "SELECT archived_at FROM production WHERE id = $1",
    [productionId],
  );
  return res.rows[0]?.archived_at != null;
}

export async function archiveProduction(id: string): Promise<void> {
  await getPool().query(
    "UPDATE production SET archived_at = NOW() WHERE id = $1",
    [id],
  );
}

export async function unarchiveProduction(id: string): Promise<void> {
  await getPool().query(
    "UPDATE production SET archived_at = NULL WHERE id = $1",
    [id],
  );
}

export async function listProductionMembers(
  productionId: string,
): Promise<{ userId: string; name: string; avatarUrl: string | null; isAdmin: boolean }[]> {
  const res = await getPool().query<{ user_id: string; name: string | null; avatar_url: string | null; is_super_admin: boolean | null }>(
    `SELECT pm.user_id, up.name, up.avatar_url, fu.is_super_admin
     FROM production_member pm
     LEFT JOIN user_profile up ON up.user_id = pm.user_id
     LEFT JOIN feishu_user fu ON fu.user_id = pm.user_id
     WHERE pm.production_id = $1 AND pm.status <> 'exited'
     ORDER BY up.name NULLS LAST`,
    [productionId],
  );
  return res.rows.map(r => ({ userId: r.user_id, name: r.name ?? "", avatarUrl: r.avatar_url, isAdmin: r.is_super_admin ?? false }));
}

/**
 * 入组写点（邀请接受 / 直接加人都走这里）。
 *
 * ON CONFLICT 必须 DO UPDATE 而不是 DO NOTHING（#141）：退出后成员行是**留着**的
 * （status='exited'/'suspended'，署名与历史要能追溯）。DO NOTHING 会让「重新邀请
 * 一个退出过的人」变成一条静默空操作——行还在，status 还是 exited，人永远进不来，
 * 而界面显示邀请已接受。
 *
 * 复活即回到 active 并清空成因；旧授权不在这里恢复：exited 的授权在确认离组时已
 * 真撤（回来是新 membership），suspended 的授权本就冻着、复活即原样生效（复职零
 * 重配）。两种情形都不需要这里做任何授权动作。
 */
export async function addProductionMember(productionId: string, userId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: before } = await client.query<{ status: string }>(
      `SELECT status FROM production_member
        WHERE production_id = $1 AND user_id = $2 FOR UPDATE`,
      [productionId, userId],
    );
    const fromStatus = before[0]?.status ?? null;

    await client.query(
      `INSERT INTO production_member (production_id, user_id) VALUES ($1, $2)
       ON CONFLICT (production_id, user_id) DO UPDATE
          SET status = 'active', status_source = NULL,
              status_changed_at = NOW(), status_changed_by = NULL`,
      [productionId, userId],
    );

    // 只有真的复活了才留痕；首次入组与对 active 行的重复调用都不写审计行。
    if (fromStatus && fromStatus !== "active") {
      await client.query(
        `INSERT INTO production_member_status_audit
           (production_id, user_id, action, from_status, to_status, actor_id, note)
         VALUES ($1, $2, 'restore', $3, 'active', NULL, '重新入组')`,
        [productionId, userId, fromStatus],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// removeProductionMember 已删（#141）：成员行不可删除。
//
// 它此前撤权 + 删行，定位是「误加入」。但审计上删行就是抹痕迹，而「谁在什么时候被
// 谁从剧组里拿掉」正是最该留下的一条；留着这个函数，就等于留着一把抹痕迹的刀。
// 唯一的移出路径是 lib/perm/member-status.ts 的 suspend → confirmMemberExit：撤销授权、
// 保留成员行与完整轨迹。

export async function setMemberRoles(
  productionId: string,
  userId: string,
  roles: string[],
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Keep TEXT[] in sync for backward compat (dropped in Phase 3)
    await client.query(
      "UPDATE production_member SET roles = $3 WHERE production_id = $1 AND user_id = $2",
      [productionId, userId, roles],
    );

    // Rebuild production_member_role FK rows
    await client.query(
      "DELETE FROM production_member_role WHERE production_id = $1 AND user_id = $2",
      [productionId, userId],
    );
    if (roles.length > 0) {
      await client.query(
        `INSERT INTO production_member_role (production_id, user_id, role_id)
         SELECT $1, $2, pr.id
         FROM production_role pr
         WHERE pr.production_id = $1 AND pr.name = ANY($3::text[])
         ON CONFLICT DO NOTHING`,
        [productionId, userId, roles],
      );
    }

    // Cascade-revoke self_confirmed grants no longer covered by new roles or dept zone.
    await recomputeAndRevokeGrants(userId, productionId, "role_change", client);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function setMemberPhoto(
  productionId: string,
  userId: string,
  photoUrl: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE production_member SET photo_url = $3 WHERE production_id = $1 AND user_id = $2",
    [productionId, userId, photoUrl],
  );
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export type Mention = { userId: string; name: string };

export type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  userId: string;
  authorName: string;
  body: string;
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
};

type CommentRow = {
  id: string;
  production_id: string;
  context_type: string;
  context_id: string;
  parent_id: string | null;
  user_id: string;
  author_name: string;
  body: string;
  mentions: Mention[];
  created_at: Date;
  updated_at: Date;
};

function rowToComment(r: CommentRow): Comment {
  return {
    id: r.id,
    productionId: r.production_id,
    contextType: r.context_type,
    contextId: r.context_id,
    parentId: r.parent_id,
    userId: r.user_id,
    authorName: r.author_name,
    body: r.body,
    mentions: r.mentions ?? [],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listProductionComments(productionId: string): Promise<Comment[]> {
  const res = await getPool().query<CommentRow>(
    `SELECT id, production_id, context_type, context_id, parent_id,
            user_id, author_name, body, mentions, created_at, updated_at
     FROM comment WHERE production_id = $1 ORDER BY created_at ASC`,
    [productionId]
  );
  return res.rows.map(rowToComment);
}

export async function createComment(
  productionId: string,
  contextType: string,
  contextId: string,
  parentId: string | null,
  userId: string,
  authorName: string,
  body: string,
  mentions: Mention[],
): Promise<Comment> {
  const res = await getPool().query<CommentRow>(
    `INSERT INTO comment
       (production_id, context_type, context_id, parent_id, user_id, author_name, body, mentions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, production_id, context_type, context_id, parent_id,
               user_id, author_name, body, mentions, created_at, updated_at`,
    [productionId, contextType, contextId, parentId, userId, authorName, body, JSON.stringify(mentions)],
  );
  return rowToComment(res.rows[0]);
}

export async function getCommentById(id: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `SELECT id, production_id, context_type, context_id, parent_id,
            user_id, author_name, body, mentions, created_at, updated_at
     FROM comment WHERE id = $1`,
    [id],
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function updateComment(id: string, userId: string, body: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `UPDATE comment SET body = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3
     RETURNING id, production_id, context_type, context_id, parent_id,
               user_id, author_name, body, mentions, created_at, updated_at`,
    [body, id, userId],
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function deleteComment(id: string, userId: string, isAdmin: boolean): Promise<boolean> {
  const res = isAdmin
    ? await getPool().query("DELETE FROM comment WHERE id = $1 RETURNING id", [id])
    : await getPool().query("DELETE FROM comment WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
  return res.rows.length > 0;
}

// ─── Production detail ────────────────────────────────────────────────────────

export async function getProductionName(id: string): Promise<string | null> {
  const res = await getPool().query<{ name: string }>(
    "SELECT name FROM production WHERE id = $1",
    [id]
  );
  return res.rows[0]?.name ?? null;
}

export type ProductionMeta = {
  name: string;
  description: string;
  avatarUrl: string | null;
  type: string | null;
  typeLabel: string | null;
  language: string | null;
  watermarkEnabled: boolean;
};

export async function getProductionOwnerInfo(id: string): Promise<{ ownerId: string | null; archived: boolean } | null> {
  const res = await getPool().query<{ owner_id: string | null; archived_at: Date | null }>(
    "SELECT owner_id, archived_at FROM production WHERE id = $1",
    [id],
  );
  if (!res.rows.length) return null;
  return { ownerId: res.rows[0].owner_id, archived: res.rows[0].archived_at != null };
}

export async function getProductionMeta(id: string): Promise<ProductionMeta | null> {
  const res = await getPool().query<{
    name: string;
    description: string;
    avatar_url: string | null;
    type: string | null;
    type_label: string | null;
    language: string | null;
    watermark_enabled: boolean;
  }>(
    "SELECT name, description, avatar_url, type, type_label, language, watermark_enabled FROM production WHERE id = $1",
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    name: r.name,
    description: r.description,
    avatarUrl: r.avatar_url,
    type: r.type,
    typeLabel: r.type_label,
    language: r.language,
    watermarkEnabled: r.watermark_enabled,
  };
}

/** 管理后台·项目概览的基础统计（只读聚合，门=管理面资格）。 */
export async function getAdminOverviewStats(productionId: string): Promise<{
  memberCount: number;
  suspendedCount: number;
  deptCount: number;
  groupCount: number;
  roleCount: number;
  activeGrantCount: number;
  milestoneCount: number;
  announcementCount: number;
  createdAt: string;
  archivedAt: string | null;
}> {
  const res = await getPool().query<{
    member_count: string; suspended_count: string; dept_count: string; group_count: string;
    role_count: string; active_grant_count: string; milestone_count: string; announcement_count: string;
    created_at: Date; archived_at: Date | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM production_member pm
         WHERE pm.production_id = p.id AND pm.status <> 'exited') AS member_count,
       (SELECT COUNT(*) FROM production_member pm WHERE pm.production_id = p.id AND pm.status = 'suspended') AS suspended_count,
       (SELECT COUNT(*) FROM production_dept d WHERE d.production_id = p.id AND d.kind = 'dept') AS dept_count,
       (SELECT COUNT(*) FROM production_dept d WHERE d.production_id = p.id AND d.kind = 'group') AS group_count,
       (SELECT COUNT(*) FROM production_role r WHERE r.production_id = p.id AND NOT r.is_deprecated) AS role_count,
       (SELECT COUNT(*) FROM production_member_grant g WHERE g.production_id = p.id
          AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > NOW())) AS active_grant_count,
       (SELECT COUNT(*) FROM milestone m WHERE m.production_id = p.id) AS milestone_count,
       (SELECT COUNT(*) FROM production_announcement a WHERE a.production_id = p.id) AS announcement_count,
       p.created_at, p.archived_at
     FROM production p WHERE p.id = $1`,
    [productionId],
  );
  const r = res.rows[0];
  return {
    memberCount: Number(r?.member_count ?? 0),
    suspendedCount: Number(r?.suspended_count ?? 0),
    deptCount: Number(r?.dept_count ?? 0),
    groupCount: Number(r?.group_count ?? 0),
    roleCount: Number(r?.role_count ?? 0),
    activeGrantCount: Number(r?.active_grant_count ?? 0),
    milestoneCount: Number(r?.milestone_count ?? 0),
    announcementCount: Number(r?.announcement_count ?? 0),
    createdAt: r?.created_at?.toISOString() ?? "",
    archivedAt: r?.archived_at?.toISOString() ?? null,
  };
}

/** 水印渲染信息：开关 + 当前用户 [显示名 邮箱]。production layout SSR 消费。
 *  注：productionId 仅取 watermark_enabled；身份两个 LEFT JOIN 直接按 $2 键连，
 *  与 production 无关联（单行、无 fan-out）。 */
export async function getWatermarkInfo(
  productionId: string,
  userId: string,
): Promise<{ enabled: boolean; name: string; email: string | null }> {
  const res = await getPool().query<{ enabled: boolean; name: string | null; email: string | null }>(
    `SELECT p.watermark_enabled AS enabled,
            COALESCE(up.display_name, up.name, fu.name) AS name,
            COALESCE(
              (SELECT upi.platform_user_id FROM user_platform_identity upi
               WHERE upi.user_id = $2 AND upi.platform_id = 'email'
               ORDER BY upi.is_primary DESC, upi.created_at DESC LIMIT 1),
              fu.email
            ) AS email
     FROM production p
     LEFT JOIN user_profile up ON up.user_id = $2
     LEFT JOIN feishu_user fu ON fu.user_id = $2
     WHERE p.id = $1`,
    [productionId, userId],
  );
  const r = res.rows[0];
  return { enabled: r?.enabled ?? false, name: r?.name ?? "", email: r?.email ?? null };
}

export async function updateProductionName(id: string, name: string): Promise<void> {
  await getPool().query("UPDATE production SET name = $1 WHERE id = $2", [name, id]);
}

export type MemberWithRoles = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  email: string | null;
  phone: string | null;
  roles: string[];
  tags: string[];
  photoUrl: string | null;
  supervisorId: string | null;
  supervisorName: string | null;
  status: MemberStatus;
  /** 非 active 时的成因：self=自助退出，admin=人事停用 */
  statusSource: MemberStatusSource | null;
  statusChangedAt: Date | null;
};

/**
 * 名册。默认不含已离组的人（exited）——他们不在剧组了，但行留着，历史可查。
 * includeExited 供组织页的「显示已离组」用。suspended 始终在册并带成因，
 * 因为「谁停用着、等谁处置」正是名册要回答的问题。
 */
export async function listProductionMembersWithRoles(
  productionId: string,
  opts: { includeExited?: boolean } = {},
): Promise<MemberWithRoles[]> {
  const res = await getPool().query<{
    user_id: string; name: string | null; avatar_url: string | null; is_super_admin: boolean | null;
    email: string | null; phone: string | null; roles: string[]; tags: string[]; photo_url: string | null;
    supervisor_id: string | null; supervisor_name: string | null; status: string;
    status_source: MemberStatusSource | null; status_changed_at: Date | null;
  }>(
    `SELECT pm.user_id, up.name, up.avatar_url, fu.is_super_admin,
            COALESCE(
              (SELECT upi.platform_user_id FROM user_platform_identity upi
               WHERE upi.user_id = pm.user_id AND upi.platform_id = 'email'
               ORDER BY upi.is_primary DESC, upi.created_at DESC LIMIT 1),
              fu.email
            ) AS email,
            COALESCE(up.phone, fu.phone) AS phone, pm.roles, pm.photo_url,
            pm.supervisor_id, sup.name AS supervisor_name,
            COALESCE(pm.status, 'active') AS status,
            pm.status_source, pm.status_changed_at,
            COALESCE(
              ARRAY(
                SELECT pmt.name
                FROM production_member_tag_assignment pmta
                JOIN production_member_tag pmt ON pmt.id = pmta.tag_id
                WHERE pmta.production_id = pm.production_id AND pmta.user_id = pm.user_id
                ORDER BY pmt.is_system DESC, pmt.name
              ),
              '{}'::text[]
            ) AS tags
     FROM production_member pm
     LEFT JOIN user_profile up ON up.user_id = pm.user_id
     LEFT JOIN feishu_user fu ON fu.user_id = pm.user_id
     LEFT JOIN user_profile sup ON sup.user_id = pm.supervisor_id
     WHERE pm.production_id = $1 AND ($2 OR pm.status <> 'exited')
     ORDER BY up.name NULLS LAST`,
    [productionId, opts.includeExited ?? false],
  );
  return res.rows.map((r) => ({
    userId: r.user_id,
    name: r.name ?? "",
    avatarUrl: r.avatar_url,
    isAdmin: r.is_super_admin ?? false,
    email: r.email,
    phone: r.phone,
    roles: r.roles,
    tags: r.tags,
    photoUrl: r.photo_url,
    supervisorId: r.supervisor_id,
    supervisorName: r.supervisor_name,
    status: r.status as MemberStatus,
    statusSource: r.status_source,
    statusChangedAt: r.status_changed_at,
  }));
}

// ─── Member tags ──────────────────────────────────────────────────────────────

export type MemberTag = {
  id: string;
  name: string;
  isSystem: boolean;
  productionId: string | null;
};

/** Lists all tags available in a production (system-wide + custom for this production). */
export async function listMemberTags(productionId: string): Promise<MemberTag[]> {
  const { rows } = await getPool().query<{
    id: string; name: string; is_system: boolean; production_id: string | null;
  }>(
    `SELECT id, name, is_system, production_id
     FROM production_member_tag
     WHERE production_id IS NULL OR production_id = $1
     ORDER BY is_system DESC, name`,
    [productionId],
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    isSystem: r.is_system,
    productionId: r.production_id,
  }));
}

/** Creates a custom tag for a production. Rejects system tag names. */
export async function createMemberTag(
  productionId: string,
  name: string,
): Promise<MemberTag> {
  const existing = await getPool().query<{ id: string }>(
    "SELECT id FROM production_member_tag WHERE name = $1 AND production_id IS NULL",
    [name],
  );
  if (existing.rows.length > 0) {
    throw new Error("SYSTEM_TAG_NAME_CONFLICT");
  }
  const { rows } = await getPool().query<{
    id: string; name: string; is_system: boolean; production_id: string | null;
  }>(
    `INSERT INTO production_member_tag (production_id, name, is_system)
     VALUES ($1, $2, false)
     RETURNING id, name, is_system, production_id`,
    [productionId, name],
  );
  return {
    id: rows[0].id,
    name: rows[0].name,
    isSystem: rows[0].is_system,
    productionId: rows[0].production_id,
  };
}

/** Deletes a custom (non-system) tag. Cascades to tag assignments. */
export async function deleteMemberTag(tagId: string, productionId: string): Promise<void> {
  const { rows } = await getPool().query<{ is_system: boolean; production_id: string | null }>(
    "SELECT is_system, production_id FROM production_member_tag WHERE id = $1",
    [tagId],
  );
  if (rows.length === 0) throw new Error("TAG_NOT_FOUND");
  if (rows[0].is_system || rows[0].production_id !== productionId) {
    throw new Error("TAG_NOT_DELETABLE");
  }
  await getPool().query("DELETE FROM production_member_tag WHERE id = $1", [tagId]);
}

/** Gets all tag IDs assigned to a member in a production. */
export async function getMemberTagIds(productionId: string, userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ tag_id: string }>(
    "SELECT tag_id FROM production_member_tag_assignment WHERE production_id = $1 AND user_id = $2",
    [productionId, userId],
  );
  return rows.map(r => r.tag_id);
}

/** Replaces all tag assignments for a member atomically. */
export async function setMemberTags(
  productionId: string,
  userId: string,
  tagIds: string[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM production_member_tag_assignment WHERE production_id = $1 AND user_id = $2",
      [productionId, userId],
    );
    if (tagIds.length > 0) {
      await client.query(
        `INSERT INTO production_member_tag_assignment (production_id, user_id, tag_id)
         SELECT $1, $2, t.id
         FROM unnest($3::uuid[]) AS t(id)
         JOIN production_member_tag pmt ON pmt.id = t.id
         WHERE pmt.production_id IS NULL OR pmt.production_id = $1
         ON CONFLICT DO NOTHING`,
        [productionId, userId, tagIds],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── Member supervisor / status ───────────────────────────────────────────────

export async function setMemberSupervisor(
  productionId: string,
  userId: string,
  supervisorId: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE production_member SET supervisor_id = $3 WHERE production_id = $1 AND user_id = $2",
    [productionId, userId, supervisorId],
  );
}

// setMemberStatus 已退役（#141）：裸 UPDATE 不写审计、也分不清成因（自助退出还是
// 人事停用）。状态机的唯一写点是 lib/perm/member-status.ts，端点见
// app/api/production/[id]/members/[userId]/status/route.ts。

/** Returns Feishu open_ids of 制作人 / 制作助理 — used by Feishu bot to add them to dept chats. */
export async function getBossOpenIds(productionId: string): Promise<string[]> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT fu.open_id
     FROM production_member pm
     JOIN feishu_user fu ON fu.user_id = pm.user_id
     WHERE pm.production_id = $1 AND pm.status = 'active'
       AND ('制作人' = ANY(pm.roles) OR '制作助理' = ANY(pm.roles))`,
    [productionId],
  );
  return res.rows.map(r => r.open_id);
}

export async function getBossUserIds(productionId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT pm.user_id
     FROM production_member pm
     WHERE pm.production_id = $1 AND pm.status = 'active'
       AND ('制作人' = ANY(pm.roles) OR '制作助理' = ANY(pm.roles))`,
    [productionId],
  );
  return res.rows.map(r => r.user_id);
}

// ─── Contact import ───────────────────────────────────────────────────────────

export async function findUserByName(name: string): Promise<{ userId: string } | null> {
  const res = await getPool().query<{ user_id: string }>(
    "SELECT user_id FROM user_profile WHERE name = $1 LIMIT 1",
    [name],
  );
  return res.rows[0] ? { userId: res.rows[0].user_id } : null;
}

export type CharacterDetail = Character & {
  gender: string;
  biography: string;
  roleType: string;
  memberIds: string[]; // IDs of constituent characters (only non-empty for aggregate)
};

// Upserts a production member with roles and an optional production-specific photo.
// Photo only overwrites if a new value is provided.
export async function listProductionCharacters(productionId: string): Promise<CharacterDetail[]> {
  console.error(`[fallback] listProductionCharacters called without versionId for production ${productionId} — caller should use listCharactersByVersion directly`);
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return [];
  return listCharactersByVersion(versionId);
}

export async function setCharacterMembers(productionId: string, aggregateId: string, memberIds: string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const allIds = [...new Set([aggregateId, ...memberIds])];
    const ownerRes = await client.query<{ id: string }>(
      "SELECT id FROM character WHERE production_id = $1 AND id = ANY($2::text[])",
      [productionId, allIds]
    );
    if (ownerRes.rows.length !== allIds.length) {
      throw new Error("Character aggregate members must belong to the production");
    }
    await client.query("DELETE FROM character_aggregate WHERE aggregate_id = $1", [aggregateId]);
    if (memberIds.length > 0) {
      await client.query(
        `INSERT INTO character_aggregate (aggregate_id, member_id)
         SELECT $1::text, unnest($2::text[])`,
        [aggregateId, memberIds]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function bulkUpsertBlockTags(
  tags: Array<{ blockId: string; groupId: string; optionId: string }>
): Promise<void> {
  if (!tags.length) return;
  await getPool().query(
    `INSERT INTO block_tag (block_id, group_id, option_id, updated_at)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), now()
     ON CONFLICT (block_id, group_id) DO UPDATE SET option_id = EXCLUDED.option_id, updated_at = now()`,
    [tags.map(t => t.blockId), tags.map(t => t.groupId), tags.map(t => t.optionId)]
  );
}

export async function patchCharacterMeta(
  id: string,
  versionId: string,
  fields: { gender?: string; biography?: string; roleType?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, versionId];
  if (fields.gender    !== undefined) { sets.push(`gender    = $${vals.push(fields.gender)}`); }
  if (fields.biography !== undefined) { sets.push(`biography = $${vals.push(fields.biography)}`); }
  if (fields.roleType  !== undefined) { sets.push(`role_type = $${vals.push(fields.roleType)}`); }
  if (!sets.length) return;
  await getPool().query(
    `UPDATE character_version SET ${sets.join(", ")} WHERE character_id = $1 AND version_id = $2`,
    vals
  );
}

export async function listScenesByVersion(versionId: string): Promise<SceneDetail[]> {
  const [res, labels] = await Promise.all([getPool().query<{
    id: string; name: string; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: string | null;
  }>(
    `${VERSION_SCENES_FROM_MARKERS_CTE}
     SELECT ms.id,
            COALESCE(ms.marker_meta->>'name', '') AS name,
            ms.parent_id,
            ms.marker_meta->>'synopsis' AS synopsis,
            ms.marker_meta->>'actionLine' AS action_line,
            ms.marker_meta->>'music' AS music,
            ms.marker_meta->>'stageNotes' AS stage_notes,
            ms.marker_meta->>'expectedDuration' AS expected_duration
     FROM marker_scenes ms
     ORDER BY ms.sort_key`,
    [versionId]
  ), getMarkerLabelIndex(versionId)]);
  return res.rows.map((r) => ({
    id: r.id, number: labels.labelByMarkerId.get(r.id) ?? "", name: r.name, parentId: r.parent_id,
    synopsis: r.synopsis ?? "",
    actionLine: r.action_line ?? "",
    music: r.music ?? "",
    stageNotes: r.stage_notes ?? "",
    expectedDuration: r.expected_duration ?? "",
  }));
}

export async function listCharactersByVersion(versionId: string): Promise<CharacterDetail[]> {
  const pool = getPool();
  const [charsRes, membersRes] = await Promise.all([
    pool.query<{
      id: string; name: string; is_aggregate: boolean;
      gender: string | null; biography: string | null; role_type: string | null;
    }>(
      `SELECT character_id AS id, name, is_aggregate, gender, biography, role_type
       FROM character_version
       WHERE version_id = $1
       ORDER BY sort_order`,
      [versionId]
    ),
    pool.query<{ aggregate_id: string; member_id: string }>(
      `SELECT ca.aggregate_id, ca.member_id FROM character_aggregate ca
       JOIN character_version cv ON cv.character_id = ca.aggregate_id
       WHERE cv.version_id = $1`,
      [versionId]
    ),
  ]);
  const memberMap = new Map<string, string[]>();
  for (const row of membersRes.rows) {
    if (!memberMap.has(row.aggregate_id)) memberMap.set(row.aggregate_id, []);
    memberMap.get(row.aggregate_id)!.push(row.member_id);
  }
  return charsRes.rows.map((r) => ({
    id: r.id, name: r.name, isAggregate: r.is_aggregate,
    gender: r.gender ?? "",
    biography: r.biography ?? "",
    roleType: r.role_type ?? "",
    memberIds: memberMap.get(r.id) ?? [],
  }));
}

export async function listProductionScenes(productionId: string): Promise<SceneDetail[]> {
  console.error(`[fallback] listProductionScenes called without versionId for production ${productionId} — caller should use listScenesByVersion directly`);
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return [];
  return listScenesByVersion(versionId);
}

export async function listRehearsalMarksByVersion(versionId: string): Promise<Record<string, string[]>> {
  const res = await getPool().query<{ scene_id: string | null; rehearsal_mark: string | null; type: string }>(
    `${VERSION_OWNED_BLOCKS_CTE}
     SELECT scene_id, rehearsal_mark, type
     FROM owned_blocks
     ORDER BY sort_key`,
    [versionId]
  );
  return generatedRehearsalMarksByScene(res.rows.map((row) => ({
    sceneId: row.scene_id,
    rehearsalMark: row.rehearsal_mark,
    type: row.type,
  })));
}


export async function getCharacterById(id: string, productionId: string, versionId?: string | null): Promise<CharacterDetail | null> {
  const resolvedVersionId = versionId ?? await (async () => {
    console.error(`[fallback] getCharacterById called without versionId for char ${id} production ${productionId} — frontend bug`);
    return getActiveVersionId(productionId);
  })();
  if (!resolvedVersionId) return null;

  const pool = getPool();
  const [charRes, membersRes] = await Promise.all([
    pool.query<{
      id: string; name: string; is_aggregate: boolean;
      gender: string | null; biography: string | null; role_type: string | null;
    }>(
      `SELECT cv.character_id AS id, cv.name, cv.is_aggregate, cv.gender, cv.biography, cv.role_type
       FROM character_version cv
       JOIN character c ON c.id = cv.character_id
       WHERE cv.character_id = $1 AND c.production_id = $2 AND cv.version_id = $3`,
      [id, productionId, resolvedVersionId]
    ),
    pool.query<{ member_id: string }>(
      "SELECT member_id FROM character_aggregate WHERE aggregate_id = $1",
      [id]
    ),
  ]);
  const r = charRes.rows[0];
  return r ? {
    id: r.id, name: r.name, isAggregate: r.is_aggregate,
    gender: r.gender ?? "", biography: r.biography ?? "", roleType: r.role_type ?? "",
    memberIds: membersRes.rows.map((m) => m.member_id),
  } : null;
}

export type SceneDetail = Scene & {
  synopsis: string;
  actionLine: string;
  music: string;
  stageNotes: string;
  expectedDuration: string;
};

export async function listMarkerProjectionByVersion(
  versionId: string,
): Promise<MarkerProjection[]> {
  const [blocksRes, labels] = await Promise.all([
    getPool().query<Pick<BlockRow, "block_id" | "scene_id" | "marker_meta" | "type">>(
      `SELECT sv.block_id, s.scene_id, s.marker_meta, s.type
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
         AND s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
       ORDER BY sv.sort_key`,
      [versionId],
    ),
    getMarkerLabelIndex(versionId),
  ]);
  const blocks: Block[] = blocksRes.rows.map((row) => {
    const { type, lyric } = fromDbType(row.type);
    return {
      id: row.block_id,
      type,
      lyric,
      content: "",
      forceShowCharacterName: false,
      sceneId: isChapterSceneMarkerType(row.type) ? row.block_id : row.scene_id,
      rehearsalMark: null,
      markerMeta: cleanMarkerMeta(row.marker_meta),
      characterIds: [],
      characterAnnotations: {},
    };
  });
  return projectMarkers({ blocks, scenes: [] }, [], labels);
}

export async function getSceneById(
  sceneId: string, productionId: string, versionId?: string | null
): Promise<SceneDetail | null> {
  if (versionId) {
    const markerScenes = await listScenesByVersion(versionId);
    const markerScene = markerScenes.find((scene) => scene.id === sceneId);
    return markerScene ?? null;
  }
  // No cookie version: fall back to production's active version
  console.error(`[fallback] getSceneById called without versionId for scene ${sceneId} production ${productionId} — frontend bug`);
  const activeVersionId = await getActiveVersionId(productionId);
  if (!activeVersionId) return null;
  return getSceneById(sceneId, productionId, activeVersionId);
}

export async function updateSceneMetadata(
  productionId: string,
  sceneId: string,
  versionId: string,
  fields: Partial<Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">>
): Promise<void> {
  const meta: MarkerMeta = {};
  for (const key of ["synopsis", "actionLine", "music", "stageNotes", "expectedDuration"] as const) {
    if (key in fields) meta[key] = fields[key] ?? "";
  }
  if (Object.keys(meta).length === 0) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const versionRes = await client.query<{ production_id: string }>(
      "SELECT production_id FROM version WHERE id = $1",
      [versionId]
    );
    if (versionRes.rows[0]?.production_id !== productionId) {
      throw new Error("Scene metadata version does not belong to production");
    }
    const markerRes = await client.query<{ snapshot_id: string; production_id: string; refs: string }>(
      `SELECT sv.snapshot_id, s.production_id, COUNT(*) OVER (PARTITION BY sv.block_id) AS refs
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $2
         AND sv.block_id = $1
         AND s.type IN ('chapter_marker', 'scene_marker')`,
      [sceneId, versionId]
    );
    // marker 是构作字段的唯一真相源，scene_version 只是它的派生读模型。
    // 没有 marker block 就没有可写之处——旧的「直写 scene_version」回落分支
    // 已随存量版本全量 marker 化而作废（#159）。
    if (markerRes.rows.length !== 1) {
      throw new Error(`Expected exactly one marker block for scene ${sceneId} in version ${versionId}, found ${markerRes.rows.length}`);
    }
    const marker = markerRes.rows[0];
    if (marker.production_id !== productionId) {
      throw new Error("Scene marker does not belong to production");
    }
    const refRes = await client.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM script_version WHERE snapshot_id = $1",
      [marker.snapshot_id]
    );
    const refCount = parseInt(refRes.rows[0]?.cnt ?? "0", 10);
    if (refCount <= 1) {
      await client.query(
        `UPDATE script
         SET marker_meta = COALESCE(marker_meta, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [marker.snapshot_id, JSON.stringify(meta)]
      );
    } else {
      const newSnapshotId = genSnapshotId();
      await client.query(
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
         SELECT $1, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment,
                COALESCE(marker_meta, '{}'::jsonb) || $2::jsonb, force_show_character_name
         FROM script
         WHERE id = $3`,
        [newSnapshotId, JSON.stringify(meta), marker.snapshot_id]
      );
      await client.query(
        `UPDATE script_version
         SET snapshot_id = $1
         WHERE version_id = $2 AND block_id = $3`,
        [newSnapshotId, versionId, sceneId]
      );
    }
    await syncSceneVersionsFromMarkersInTx(client, marker.production_id, versionId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── listProductionDepts（随成员段搬 perm/；与 perm/dept-db 同名不同返回类型，届时消解）──

import type { MemberStatus, MemberStatusSource } from "./perm/member-status-shared";

export async function listProductionDepts(
  productionId: string,
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await getPool().query<{ id: string; name: string }>(
    `SELECT id, name FROM production_dept WHERE production_id = $1 ORDER BY display_order, name`,
    [productionId],
  );
  return rows;
}

// ─── 成员 upsert（随成员段搬 perm/member-db）───────────────────────────────────

export async function upsertProductionMemberWithRoles(
  productionId: string,
  userId: string,
  roles: string[],
  photoUrl: string | null,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO production_member (production_id, user_id, roles, photo_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (production_id, user_id) DO UPDATE
         SET roles     = EXCLUDED.roles,
             photo_url = EXCLUDED.photo_url`,
      [productionId, userId, roles, photoUrl],
    );

    // Rebuild production_member_role FK rows
    await client.query(
      "DELETE FROM production_member_role WHERE production_id = $1 AND user_id = $2",
      [productionId, userId],
    );
    if (roles.length > 0) {
      await client.query(
        `INSERT INTO production_member_role (production_id, user_id, role_id)
         SELECT $1, $2, pr.id
         FROM production_role pr
         WHERE pr.production_id = $1 AND pr.name = ANY($3::text[])
         ON CONFLICT DO NOTHING`,
        [productionId, userId, roles],
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── Block Tags ───────────────────────────────────────────────────────────────

export type TagOption = {
  id: string;
  groupId: string;
  label: string;
  color: string;
  sortOrder: number;
};

export type TagGroup = {
  id: string;
  productionId: string;
  name: string;
  type: 'exclusive' | 'range';
  rangeMin: number | null;
  rangeMax: number | null;
  rangeStep: number | null;
  rangeDefault: number | null;
  defaultOptionId: string | null;
  lyricSplitAfterOptionId: string | null;
  sortOrder: number;
  options: TagOption[];
};

export type BlockTagValue = {
  blockId: string;
  groupId: string;
  optionId: string | null;
  value: number | null;
};

type TagGroupRow = {
  id: string;
  production_id: string;
  name: string;
  type: 'exclusive' | 'range';
  range_min: string | null;
  range_max: string | null;
  range_step: string | null;
  range_default: string | null;
  default_option_id: string | null;
  lyric_split_after_option_id: string | null;
  sort_order: number;
  option_id: string | null;
  option_label: string | null;
  option_color: string | null;
  option_sort_order: number | null;
};

type TagOptionRow = {
  id: string;
  group_id: string;
  label: string;
  color: string;
  sort_order: number;
};

type BlockTagRow = {
  block_id: string;
  group_id: string;
  option_id: string | null;
  value: string | null;
};

function rowToTagOption(r: TagOptionRow): TagOption {
  return {
    id: r.id,
    groupId: r.group_id,
    label: r.label,
    color: r.color,
    sortOrder: r.sort_order,
  };
}

export async function listTagGroups(productionId: string): Promise<TagGroup[]> {
  const res = await getPool().query<TagGroupRow>(
    `SELECT tg.id, tg.production_id, tg.name, tg.type,
            tg.range_min, tg.range_max, tg.range_step, tg.range_default,
            tg.default_option_id, tg.lyric_split_after_option_id, tg.sort_order,
            topt.id AS option_id, topt.label AS option_label,
            topt.color AS option_color, topt.sort_order AS option_sort_order
     FROM tag_group tg
     LEFT JOIN tag_option topt ON topt.group_id = tg.id
     WHERE tg.production_id = $1
     ORDER BY tg.sort_order, topt.sort_order`,
    [productionId]
  );
  const groupMap = new Map<string, TagGroup>();
  for (const r of res.rows) {
    if (!groupMap.has(r.id)) {
      groupMap.set(r.id, {
        id: r.id,
        productionId: r.production_id,
        name: r.name,
        type: r.type,
        rangeMin: r.range_min != null ? Number(r.range_min) : null,
        rangeMax: r.range_max != null ? Number(r.range_max) : null,
        rangeStep: r.range_step != null ? Number(r.range_step) : null,
        rangeDefault: r.range_default != null ? Number(r.range_default) : null,
        defaultOptionId: r.default_option_id,
        lyricSplitAfterOptionId: r.lyric_split_after_option_id,
        sortOrder: r.sort_order,
        options: [],
      });
    }
    if (r.option_id != null) {
      groupMap.get(r.id)!.options.push({
        id: r.option_id,
        groupId: r.id,
        label: r.option_label!,
        color: r.option_color!,
        sortOrder: r.option_sort_order!,
      });
    }
  }
  return Array.from(groupMap.values());
}

export async function createTagGroup(
  productionId: string,
  params: {
    name: string;
    type: 'exclusive' | 'range';
    rangeMin?: number;
    rangeMax?: number;
    rangeStep?: number;
    rangeDefault?: number;
  }
): Promise<TagGroup> {
  const id = `tg${Date.now().toString(36)}`;
  const res = await getPool().query<{
    id: string; production_id: string; name: string; type: string;
    range_min: string | null; range_max: string | null;
    range_step: string | null; range_default: string | null;
    default_option_id: string | null; lyric_split_after_option_id: string | null; sort_order: number;
  }>(
    `INSERT INTO tag_group (id, production_id, name, type, range_min, range_max, range_step, range_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, production_id, name, type, range_min, range_max, range_step, range_default,
               default_option_id, lyric_split_after_option_id, sort_order`,
    [
      id, productionId, params.name, params.type,
      params.rangeMin ?? null, params.rangeMax ?? null,
      params.rangeStep ?? null, params.rangeDefault ?? null,
    ]
  );
  const r = res.rows[0];
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    type: r.type as 'exclusive' | 'range',
    rangeMin: r.range_min != null ? Number(r.range_min) : null,
    rangeMax: r.range_max != null ? Number(r.range_max) : null,
    rangeStep: r.range_step != null ? Number(r.range_step) : null,
    rangeDefault: r.range_default != null ? Number(r.range_default) : null,
    defaultOptionId: r.default_option_id,
    lyricSplitAfterOptionId: r.lyric_split_after_option_id,
    sortOrder: r.sort_order,
    options: [],
  };
}

export async function updateTagGroup(
  id: string,
  params: {
    name?: string;
    rangeMin?: number | null;
    rangeMax?: number | null;
    rangeStep?: number | null;
    rangeDefault?: number | null;
    defaultOptionId?: string | null;
    lyricSplitAfterOptionId?: string | null;
    sortOrder?: number;
  }
): Promise<TagGroup | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.name !== undefined)                    { sets.push(`name = $${idx++}`);                          values.push(params.name); }
  if (params.rangeMin !== undefined)                { sets.push(`range_min = $${idx++}`);                     values.push(params.rangeMin); }
  if (params.rangeMax !== undefined)                { sets.push(`range_max = $${idx++}`);                     values.push(params.rangeMax); }
  if (params.rangeStep !== undefined)               { sets.push(`range_step = $${idx++}`);                    values.push(params.rangeStep); }
  if (params.rangeDefault !== undefined)            { sets.push(`range_default = $${idx++}`);                 values.push(params.rangeDefault); }
  if (params.defaultOptionId !== undefined)         { sets.push(`default_option_id = $${idx++}`);             values.push(params.defaultOptionId); }
  if (params.lyricSplitAfterOptionId !== undefined) { sets.push(`lyric_split_after_option_id = $${idx++}`);   values.push(params.lyricSplitAfterOptionId); }
  if (params.sortOrder !== undefined)               { sets.push(`sort_order = $${idx++}`);                    values.push(params.sortOrder); }
  if (sets.length === 0) return null;
  values.push(id);
  const res = await getPool().query<{
    id: string; production_id: string; name: string; type: string;
    range_min: string | null; range_max: string | null;
    range_step: string | null; range_default: string | null;
    default_option_id: string | null; lyric_split_after_option_id: string | null; sort_order: number;
  }>(
    `UPDATE tag_group SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, production_id, name, type, range_min, range_max, range_step, range_default,
               default_option_id, lyric_split_after_option_id, sort_order`,
    values
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  const optRes = await getPool().query<TagOptionRow>(
    'SELECT id, group_id, label, color, sort_order FROM tag_option WHERE group_id = $1 ORDER BY sort_order',
    [id]
  );
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    type: r.type as 'exclusive' | 'range',
    rangeMin: r.range_min != null ? Number(r.range_min) : null,
    rangeMax: r.range_max != null ? Number(r.range_max) : null,
    rangeStep: r.range_step != null ? Number(r.range_step) : null,
    rangeDefault: r.range_default != null ? Number(r.range_default) : null,
    defaultOptionId: r.default_option_id,
    lyricSplitAfterOptionId: r.lyric_split_after_option_id,
    sortOrder: r.sort_order,
    options: optRes.rows.map(rowToTagOption),
  };
}

export async function deleteTagGroup(id: string): Promise<void> {
  await getPool().query('DELETE FROM tag_group WHERE id = $1', [id]);
}

export async function createTagOption(
  groupId: string,
  label: string,
  color: string,
  sortOrder: number
): Promise<TagOption> {
  const id = `to${Date.now().toString(36)}`;
  const res = await getPool().query<TagOptionRow>(
    `INSERT INTO tag_option (id, group_id, label, color, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, group_id, label, color, sort_order`,
    [id, groupId, label, color, sortOrder]
  );
  return rowToTagOption(res.rows[0]);
}

export async function updateTagOption(
  id: string,
  params: { label?: string; color?: string; sortOrder?: number }
): Promise<TagOption | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.label !== undefined)     { sets.push(`label = $${idx++}`);      values.push(params.label); }
  if (params.color !== undefined)     { sets.push(`color = $${idx++}`);      values.push(params.color); }
  if (params.sortOrder !== undefined) { sets.push(`sort_order = $${idx++}`); values.push(params.sortOrder); }
  if (sets.length === 0) return null;
  values.push(id);
  const res = await getPool().query<TagOptionRow>(
    `UPDATE tag_option SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, group_id, label, color, sort_order`,
    values
  );
  return res.rows.length ? rowToTagOption(res.rows[0]) : null;
}

export async function deleteTagOption(id: string): Promise<void> {
  await getPool().query('DELETE FROM tag_option WHERE id = $1', [id]);
}

export async function getBlockTagsForProduction(productionId: string): Promise<BlockTagValue[]> {
  const res = await getPool().query<BlockTagRow>(
    `SELECT bt.block_id, bt.group_id, bt.option_id, bt.value
     FROM block_tag bt
     JOIN tag_group tg ON tg.id = bt.group_id
     WHERE tg.production_id = $1`,
    [productionId]
  );
  return res.rows.map((r) => ({
    blockId: r.block_id,
    groupId: r.group_id,
    optionId: r.option_id,
    value: r.value != null ? Number(r.value) : null,
  }));
}

export async function upsertBlockTag(
  blockId: string,
  groupId: string,
  optionId: string | null,
  value: number | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO block_tag (block_id, group_id, option_id, value, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (block_id, group_id) DO UPDATE
       SET option_id  = EXCLUDED.option_id,
           value      = EXCLUDED.value,
           updated_at = now()`,
    [blockId, groupId, optionId, value]
  );
}

export async function deleteBlockTag(blockId: string, groupId: string): Promise<void> {
  await getPool().query(
    'DELETE FROM block_tag WHERE block_id = $1 AND group_id = $2',
    [blockId, groupId]
  );
}

// ─── Atomic patch application ─────────────────────────────────────────────────

const PAGE_LAYOUTS: PageLayout[] = ["a4", "letter", "a3-2col", "tablet-2col"];
const PAGE_MAP_CACHE_LIMIT = 64;

function cacheEstimatedPageMap(key: string, cache: EstimatedPageMapCache): EstimatedPageMapCache {
  pageMapCache.delete(key);
  pageMapCache.set(key, cache);
  while (pageMapCache.size > PAGE_MAP_CACHE_LIMIT) {
    const oldest = pageMapCache.keys().next().value;
    if (oldest === undefined) break;
    pageMapCache.delete(oldest);
  }
  return cache;
}

async function saveEstimatedPageMaps(
  productionId: string,
  versionId: string,
  blocks: Block[],
  dirty: "full" | Array<{ start: number; end: number }>,
): Promise<void> {
  // 按现存视图各算一份（#336 B2：page_map 以 script_view id 为键）。本阶段只有主本；
  // 改版式时 saveScriptConfig 触发全量重算，所以不必再为「万一换版式」预算另外三份。
  const views = await getPool().query<{ id: string; page_layout: string | null; text_layout_mode: string | null; template_id: string | null }>(
    `SELECT id, page_layout, text_layout_mode, template_overrides->>'templateId' AS template_id
     FROM script_view WHERE production_id = $1 ORDER BY sort_order, created_at`,
    [productionId],
  );
  if (views.rows.length === 0) return;
  let changed = false;
  const computed = views.rows.map((view) => {
    const key = `${productionId}:${versionId}:${view.id}`;
    const { pageLayout, textLayoutMode } = scriptViewLayout(view);
    const previous = pageMapCache.get(key) ?? null;
    const cache = updateEstimatedPageMap(
      previous,
      blocks,
      pageLayout,
      textLayoutMode,
      false,
      previous ? dirty : "full",
      isKnownTemplateId(view.template_id) ? view.template_id : null,
    );
    if (cache !== previous) changed = true;
    return { key, viewId: view.id, cache };
  });
  if (!changed) return;
  await writePageMap(productionId, Object.fromEntries(
    computed.map(({ viewId, cache }) => [viewId, cache.pageMap]),
  ));
  for (const { key, cache } of computed) cacheEstimatedPageMap(key, cache);
}

function scheduleEstimatedPageMapSave(
  productionId: string,
  versionId: string,
  dirty: "full" | Array<{ start: number; end: number }>,
): Promise<void> {
  const previous = pageMapUpdates.get(versionId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    try {
      // 只装 blocks（#461）：分页测算不吃 scenes/characters/config。事务内读的
      // 结构列没有 content，没法复用——高度估算要正文，这次读省不掉，但省成一路。
      // 版本存在性单独验：loadVersionBlocks 对已删版本返回空数组，不能拿它当哨兵。
      const [versionExists, loaded] = await Promise.all([
        getPool().query("SELECT 1 FROM version WHERE id = $1 AND production_id = $2", [versionId, productionId]),
        loadVersionBlocks(versionId),
      ]);
      if (versionExists.rows.length > 0) await saveEstimatedPageMaps(productionId, versionId, loaded.blocks, dirty);
    } catch (error) {
      deletePageMapCacheEntries(`${productionId}:${versionId}:`);
      throw error;
    }
  });
  pageMapUpdates.set(versionId, current);
  return current.finally(() => {
    if (pageMapUpdates.get(versionId) === current) pageMapUpdates.delete(versionId);
  });
}

// ── Tag helpers (used inside applyPatchToDB transaction) ──────────────────────

/**
 * Validates that every groupId in `tags` belongs to `productionId`.
 * Throws TAG_INVALID_GROUP if any group is invalid.
 */
async function validateTagsInTx(
  client: PoolClient,
  productionId: string,
  tags: TagEntry[],
): Promise<void> {
  if (tags.length === 0) return;
  const groupIds = [...new Set(tags.map(t => t.groupId))];
  const res = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM tag_group WHERE id = ANY($1::text[]) AND production_id = $2`,
    [groupIds, productionId],
  );
  if (parseInt(res.rows[0].cnt, 10) !== groupIds.length) {
    throw new Error('TAG_INVALID_GROUP');
  }
}

/**
 * Computes whether a block should be lyric based on its tags and the production's
 * lyricSplitAfterOptionId rules (OR logic across groups).
 *
 * Returns:
 *  - true / false when at least one tag group has a lyric-split rule configured
 *  - null when no lyric-split group is involved in these tags → caller should
 *    leave block.lyric unchanged
 */
async function computeDerivedLyricInTx(
  client: PoolClient,
  tags: TagEntry[],
): Promise<boolean | null> {
  const optionPairs = tags.filter(t => t.optionId !== null);
  const groupIds = tags.map(t => t.groupId);

  // Check whether any of the provided groups has a lyric-split rule
  const ruleRes = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM tag_group
     WHERE id = ANY($1::text[]) AND lyric_split_after_option_id IS NOT NULL`,
    [groupIds],
  );
  if (parseInt(ruleRes.rows[0].cnt, 10) === 0) return null; // no lyric groups → don't override

  if (optionPairs.length === 0) return false; // lyric groups present but no option selected

  const lyricRes = await client.query<{ is_lyric: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM unnest($1::text[], $2::text[]) AS t(group_id, option_id)
       JOIN tag_group tg ON tg.id = t.group_id
       JOIN tag_option split_opt ON split_opt.id = tg.lyric_split_after_option_id
       JOIN tag_option sel_opt  ON sel_opt.id  = t.option_id
       WHERE sel_opt.sort_order <= split_opt.sort_order
     ) AS is_lyric`,
    [optionPairs.map(t => t.groupId), optionPairs.map(t => t.optionId)],
  );
  return lyricRes.rows[0].is_lyric;
}

/**
 * Replaces all block_tag rows for `blockId` with `tags` atomically (within an
 * existing transaction).  Must be called after the snapshot row already exists.
 */
async function writeBlockTagsInTx(
  client: PoolClient,
  blockId: string,
  tags: TagEntry[],
): Promise<void> {
  await client.query('DELETE FROM block_tag WHERE block_id = $1', [blockId]);
  for (const tag of tags) {
    await client.query(
      `INSERT INTO block_tag (block_id, group_id, option_id, value, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [blockId, tag.groupId, tag.optionId ?? null, tag.value ?? null],
    );
  }
}

/**
 * Applies a ScriptPatch atomically to PostgreSQL.
 *
 * Design:
 *  • All ops in the patch are executed in a single transaction (all-or-nothing).
 *  • pg_advisory_xact_lock(hashtext(versionId)) serialises concurrent patches for
 *    the same version so lexKey computation and CoW never interleave.
 *  • A minimal "working state" (txBlocks / txScenes / txChars) is loaded once
 *    inside the lock; subsequent ops are applied against it sequentially.
 *  • Post-commit: cue drift (best-effort) and page-map update (fire-and-forget).
 */
export async function applyPatchToDB(
  productionId: string,
  versionId: string,
  patch: ScriptPatch,
): Promise<void> {
  if (!patch.blockOps.length && !patch.charOps.length && !patch.sceneOps.length) return;

  // Local working-state types
  type TxBlock = { blockId: string; snapshotId: string; lexKey: string; type: string; sceneId: string | null; rehearsalMark: string | null; ownerMarkerId: string | null; parentMarkerId: string | null; position: number };
  type TxScene = Scene & { sortOrder: number };
  type TxChar  = Character & { sortOrder: number };

  // Collected inside the transaction; consumed post-commit for cue drift
  const driftDeletes: Array<{ snapshotId: string; prevId: string | null; nextId: string | null }> = [];
  const driftUpdates: Array<{ oldSnapshotId: string; newSnapshotId: string; oldContent: string; newContent: string }> = [];
  let pageMapChanged = false;
  const pageMapContentPositions = new Set<number>();
  let pageMapDirtyPositions: number[] = [];

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // ── Serialise concurrent patches for the same version ────────────────────
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const versionOwner = await client.query<{ production_id: string }>(
      "SELECT production_id FROM version WHERE id = $1",
      [versionId]
    );
    if (versionOwner.rows[0]?.production_id !== productionId) {
      throw new Error("Version does not belong to production");
    }

    // ── Load current version state (within the lock) ─────────────────────────
    const blockRows = await client.query<{ block_id: string; snapshot_id: string; sort_key: string; type: string; scene_id: string | null; rehearsal_mark: string | null; owner_marker_id: string | null; marker_meta: MarkerMeta | null }>(
      `SELECT sv.block_id, sv.snapshot_id, sv.sort_key, s.type::text AS type, s.scene_id, s.rehearsal_mark, s.owner_marker_id, s.marker_meta
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
       ORDER BY sv.sort_key`,
      [versionId]
    );
    const sceneRows = await client.query<{ scene_id: string; name: string; sort_order: number; parent_id: string | null }>(
      "SELECT sv.scene_id, sv.name, sv.sort_order, sv.parent_id FROM scene_version sv WHERE sv.version_id = $1 ORDER BY sv.sort_order",
      [versionId]
    );
    const charRows = await client.query<{ character_id: string; name: string; sort_order: number; is_aggregate: boolean }>(
      "SELECT cv.character_id, cv.name, cv.sort_order, cv.is_aggregate FROM character_version cv WHERE cv.version_id = $1 ORDER BY cv.sort_order",
      [versionId]
    );

    // Working ordered block list (mutated as ops are applied)
    const txBlocks: TxBlock[] = blockRows.rows.map((r, position) => ({
      blockId: r.block_id, snapshotId: r.snapshot_id, lexKey: r.sort_key, type: r.type,
      sceneId: r.scene_id, rehearsalMark: r.rehearsal_mark, ownerMarkerId: r.owner_marker_id,
      parentMarkerId: cleanMarkerMeta(r.marker_meta).parentMarkerId ?? null,
      position,
    }));
    const toBlock = (block: TxBlock): Block => ({
      id: block.blockId,
      type: block.type as BlockType,
      content: "",
      characterIds: [],
      characterAnnotations: {},
      lyric: false,
      sceneId: block.sceneId,
      rehearsalMark: block.rehearsalMark,
      ownerMarkerId: block.ownerMarkerId,
      markerMeta: { parentMarkerId: block.parentMarkerId },
    });
    const txBlockMap = new Map<string, TxBlock>(txBlocks.map(b => [b.blockId, b]));
    const blockStructureMayChange = patch.blockOps.some((op) => {
      if (op.op !== "update") return true;
      const current = txBlockMap.get(op.block.id);
      if (!current) return false;
      return toDbType(op.block) !== current.type ||
        (op.block.sceneId ?? null) !== current.sceneId ||
        (op.block.rehearsalMark ?? null) !== current.rehearsalMark ||
        (op.block.ownerMarkerId ?? null) !== current.ownerMarkerId ||
        (op.block.markerMeta?.parentMarkerId ?? null) !== current.parentMarkerId;
    });
    const previousBlocks = blockStructureMayChange ? txBlocks.map(toBlock) : [];
    const explicitMovedBlockIds = blockStructureMayChange
      ? patch.blockOps.flatMap((op) => op.op === "reorder" ? op.movedIds ?? [] : [])
      : [];
    const movedBlockIds = explicitMovedBlockIds.length > 0
      ? new Set(explicitMovedBlockIds)
      : undefined;
    const markerMetadataIds = new Set<string>();
    const updatedBlockIds = blockStructureMayChange
      ? new Set(patch.blockOps.flatMap((op) => op.op === "update" ? [op.block.id] : []))
      : null;
    const explicitOwnershipBlockIds = blockStructureMayChange ? new Set<string>() : null;

    // Working scene / char lists
    const txScenes: TxScene[] = sceneRows.rows.map(r => ({
      id: r.scene_id, number: "", name: r.name, parentId: r.parent_id, sortOrder: r.sort_order,
    }));
    const txChars: TxChar[] = charRows.rows.map(r => ({
      id: r.character_id, name: r.name, isAggregate: r.is_aggregate, sortOrder: r.sort_order,
    }));

    // ── Pre-flight: collect data needed for post-commit cue drift ─────────────
    // Adjacency snapshot of blocks that will be deleted (before any ops run)
    for (const op of patch.blockOps) {
      if (op.op !== 'delete') continue;
      const idx = txBlocks.findIndex(b => b.blockId === op.id);
      if (idx < 0) continue;
      driftDeletes.push({
        snapshotId: txBlocks[idx].snapshotId,
        prevId: idx > 0 ? txBlocks[idx - 1].snapshotId : null,
        nextId: idx + 1 < txBlocks.length ? txBlocks[idx + 1].snapshotId : null,
      });
    }
    // Old content for blocks that will be updated (for cue offset drift detection)
    const updateSnapshotIds = patch.blockOps
      .filter(op => op.op === 'update')
      .map(op => txBlockMap.get(op.block.id)?.snapshotId)
      .filter((s): s is string => !!s);
    const oldContentMap = new Map<string, string>(); // snapshotId → old content
    if (updateSnapshotIds.length > 0) {
      const res = await client.query<{ id: string; content: string }>(
        "SELECT id, content FROM script WHERE id = ANY($1::text[])", [updateSnapshotIds]
      );
      for (const r of res.rows) oldContentMap.set(r.id, r.content);
    }

    // ── Apply scene ops ───────────────────────────────────────────────────────
    const dirtySceneIds  = new Set<string>();
    const deletedSceneIds = new Set<string>();
    for (const op of patch.sceneOps) {
      if (op.op === 'upsert') {
        const idx = txScenes.findIndex(s => s.id === op.scene.id);
        const sortOrder = idx >= 0 ? txScenes[idx].sortOrder : txScenes.length;
        const updated: TxScene = { ...op.scene, sortOrder };
        if (idx >= 0) txScenes[idx] = updated; else txScenes.push(updated);
        dirtySceneIds.add(op.scene.id);
        deletedSceneIds.delete(op.scene.id);
      } else if (op.op === 'delete') {
        const idx = txScenes.findIndex(s => s.id === op.id);
        if (idx >= 0) {
          txScenes.splice(idx, 1);
        }
        deletedSceneIds.add(op.id);
        dirtySceneIds.delete(op.id);
      } else { // reorder
        const sceneMap = new Map(txScenes.map(s => [s.id, s]));
        const newOrder = op.ids.map(id => sceneMap.get(id)).filter((s): s is TxScene => !!s);
        txScenes.length = 0;
        txScenes.push(...newOrder);
      }
    }

    // ── Apply char ops ────────────────────────────────────────────────────────
    const dirtyCharIds  = new Set<string>();
    const deletedCharIds = new Set<string>();

    for (const op of patch.charOps) {
      if (op.op === 'upsert') {
        const idx = txChars.findIndex(c => c.id === op.char.id);
        const sortOrder = idx >= 0 ? txChars[idx].sortOrder : txChars.length;
        const updated: TxChar = { ...op.char, sortOrder };
        if (idx >= 0) txChars[idx] = updated; else txChars.push(updated);
        dirtyCharIds.add(op.char.id);
        deletedCharIds.delete(op.char.id);
      } else { // delete
        const idx = txChars.findIndex(c => c.id === op.id);
        if (idx >= 0) txChars.splice(idx, 1);
        deletedCharIds.add(op.id);
        dirtyCharIds.delete(op.id);
      }
    }

    if (deletedCharIds.size > 0) {
      await client.query(
        "DELETE FROM character_version WHERE character_id = ANY($1::text[]) AND version_id = $2",
        [[...deletedCharIds], versionId]
      );
    }
    if (dirtyCharIds.size > 0) {
      const toWrite = txChars.filter(c => dirtyCharIds.has(c.id));
      await client.query(
        `INSERT INTO character (id, production_id) SELECT unnest($1::text[]), $2 ON CONFLICT (id) DO NOTHING`,
        [toWrite.map(c => c.id), productionId]
      );
      await client.query(
        `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate)
         SELECT unnest($1::text[]), $2, unnest($3::text[]), unnest($4::int[]), unnest($5::bool[])
         ON CONFLICT (character_id, version_id) DO UPDATE
           SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_aggregate = EXCLUDED.is_aggregate`,
        [toWrite.map(c => c.id), versionId,
         toWrite.map(c => c.name), toWrite.map(c => c.sortOrder), toWrite.map(c => c.isAggregate)]
      );
    }

    // ── Apply block ops ───────────────────────────────────────────────────────
    for (const op of patch.blockOps) {
      switch (op.op) {

        case 'insert': {
          pageMapChanged = true;
          // Determine insertion point.
          // afterId=null → insert at position 0 (beginning).
          // afterId provided but not found → insert at end (lenient fallback).
          const afterIdx = op.afterId !== null
            ? txBlocks.findIndex(b => b.blockId === op.afterId)
            : -1;
          const insertAt = op.afterId === null ? 0
            : afterIdx >= 0 ? afterIdx + 1
            : txBlocks.length;

          const prevLexKey = insertAt > 0 ? txBlocks[insertAt - 1].lexKey : null;
          const nextLexKey = insertAt < txBlocks.length ? txBlocks[insertAt].lexKey : null;
          const lexKey = keyBetween(prevLexKey, nextLexKey);
          const snapshotId = genSnapshotId();

          // If tags are included, validate them and derive lyric flag before insertion.
          let insertBlock = op.block;
          if (op.tags !== undefined) {
            await validateTagsInTx(client, productionId, op.tags);
            const derivedLyric = await computeDerivedLyricInTx(client, op.tags);
            if (derivedLyric !== null && derivedLyric !== op.block.lyric) {
              insertBlock = { ...op.block, lyric: derivedLyric };
            }
          }

          const insertType = toDbType(insertBlock);
          const previousBlock = txBlocks[insertAt - 1];
          const insertRehearsalMark = isMarkerBlockType(insertType)
            ? null
            : previousBlock?.type === "rehearsal_marker"
              ? previousBlock.blockId
              : previousBlock?.rehearsalMark ?? null;
          const insertOwnerMarkerId = isMarkerBlockType(insertType)
            ? null
            : previousBlock && isMarkerBlockType(previousBlock.type)
              ? previousBlock.blockId
              : previousBlock?.ownerMarkerId ?? null;
          if (
            !isMarkerBlockType(insertType) &&
            previousBlock &&
            !isMarkerBlockType(previousBlock.type) &&
            updatedBlockIds?.has(previousBlock.blockId)
          ) explicitOwnershipBlockIds?.add(previousBlock.blockId);
          if (isChapterSceneMarkerType(insertType) && insertBlock.sceneId) {
            await client.query(
              `INSERT INTO scene (id, production_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
              [insertBlock.sceneId, productionId]
            );
          }

          await client.query(
            `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::block_type, $9, $10, $11::jsonb, $12)`,
            [snapshotId, insertBlock.id, productionId, lexKey,
             insertBlock.sceneId ?? null, insertRehearsalMark, insertOwnerMarkerId,
             insertType, insertBlock.content,
             insertBlock.stageComment?.trim() || null, markerMetaJson(insertBlock), insertBlock.forceShowCharacterName ?? false]
          );
          await client.query(
            "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) VALUES ($1, $2, $3, $4)",
            [snapshotId, versionId, insertBlock.id, lexKey]
          );
          if (insertBlock.characterIds.length > 0) {
            await client.query(
              `INSERT INTO script_character (script_id, character_id, position, annotation)
               SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
              [insertBlock.characterIds.map(() => snapshotId),
               insertBlock.characterIds,
               insertBlock.characterIds.map((_, i) => i),
               insertBlock.characterIds.map(cid => insertBlock.characterAnnotations[cid] ?? null)]
            );
          }

          // Write tags atomically within the same transaction.
          if (op.tags !== undefined) {
            await writeBlockTagsInTx(client, insertBlock.id, op.tags);
          }

          const newTxBlock: TxBlock = {
            blockId: op.block.id, snapshotId, lexKey, type: insertType,
            sceneId: insertBlock.sceneId ?? null,
            rehearsalMark: insertRehearsalMark, ownerMarkerId: insertOwnerMarkerId,
            parentMarkerId: insertBlock.markerMeta?.parentMarkerId ?? null,
            position: insertAt,
          };
          txBlocks.splice(insertAt, 0, newTxBlock);
          txBlockMap.set(op.block.id, newTxBlock);
          break;
        }

        case 'update': {
          const cur = txBlockMap.get(op.block.id);
          if (!cur) break; // not in this version — skip silently

          // If tags are included, validate them and derive lyric flag before writing.
          let updateBlock = op.block;
          if (op.tags !== undefined) {
            await validateTagsInTx(client, productionId, op.tags);
            const derivedLyric = await computeDerivedLyricInTx(client, op.tags);
            if (derivedLyric !== null && derivedLyric !== op.block.lyric) {
              updateBlock = { ...op.block, lyric: derivedLyric };
            }
          }
          const nextType = toDbType(updateBlock);
          if (
            (updateBlock.sceneId ?? null) !== cur.sceneId ||
            (updateBlock.rehearsalMark ?? null) !== cur.rehearsalMark ||
            (updateBlock.ownerMarkerId ?? null) !== cur.ownerMarkerId
          ) explicitOwnershipBlockIds?.add(cur.blockId);
          const markerHierarchyChanged =
            (nextType !== cur.type && (isMarkerBlockType(nextType) || isMarkerBlockType(cur.type))) ||
            (isMarkerBlockType(nextType) && (updateBlock.markerMeta?.parentMarkerId ?? null) !== cur.parentMarkerId);
          if (!isMarkerBlockType(cur.type) || !isMarkerBlockType(nextType) || markerHierarchyChanged) {
            pageMapChanged = true;
            pageMapContentPositions.add(blockStructureMayChange ? txBlocks.indexOf(cur) : cur.position);
          }
          if (!markerHierarchyChanged && isChapterSceneMarkerType(nextType)) {
            markerMetadataIds.add(cur.blockId);
          }

          const refRes = await client.query<{ cnt: string }>(
            "SELECT COUNT(*) AS cnt FROM script_version WHERE snapshot_id = $1",
            [cur.snapshotId]
          );
          const refCount = parseInt(refRes.rows[0].cnt, 10);

          if (refCount <= 1) {
            // Sole reference — update in-place
            await client.query(
              `UPDATE script
               SET scene_id = $1, rehearsal_mark = $2, type = $3::block_type,
                   content = $4, stage_comment = $5, marker_meta = $6::jsonb, force_show_character_name = $7
               WHERE id = $8`,
              [updateBlock.sceneId ?? null, cur.rehearsalMark, nextType, updateBlock.content,
               updateBlock.stageComment?.trim() || null, markerMetaJson(updateBlock),
               updateBlock.forceShowCharacterName ?? false, cur.snapshotId]
            );
            await client.query("DELETE FROM script_character WHERE script_id = $1", [cur.snapshotId]);
            if (updateBlock.characterIds.length > 0) {
              await client.query(
                `INSERT INTO script_character (script_id, character_id, position, annotation)
                 SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
                [updateBlock.characterIds.map(() => cur.snapshotId),
                 updateBlock.characterIds,
                 updateBlock.characterIds.map((_, i) => i),
                 updateBlock.characterIds.map(cid => updateBlock.characterAnnotations[cid] ?? null)]
              );
            }
            const oldContent = oldContentMap.get(cur.snapshotId);
            if (oldContent !== undefined && oldContent !== updateBlock.content) {
              driftUpdates.push({
                oldSnapshotId: cur.snapshotId, newSnapshotId: cur.snapshotId,
                oldContent, newContent: updateBlock.content,
              });
            }
          } else {
            // Multi-referenced — copy-on-write
            const oldSnapshotId = cur.snapshotId;
            const newSnapshotId = genSnapshotId();

            await client.query(
              `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::block_type, $9, $10, $11::jsonb, $12)`,
              [newSnapshotId, updateBlock.id, productionId, cur.lexKey,
               updateBlock.sceneId ?? null, cur.rehearsalMark, cur.ownerMarkerId,
               nextType, updateBlock.content,
               updateBlock.stageComment?.trim() || null, markerMetaJson(updateBlock), updateBlock.forceShowCharacterName ?? false]
            );
            await client.query(
              "UPDATE script_version SET snapshot_id = $1 WHERE snapshot_id = $2 AND version_id = $3",
              [newSnapshotId, oldSnapshotId, versionId]
            );
            if (updateBlock.characterIds.length > 0) {
              await client.query(
                `INSERT INTO script_character (script_id, character_id, position, annotation)
                 SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
                [updateBlock.characterIds.map(() => newSnapshotId),
                 updateBlock.characterIds,
                 updateBlock.characterIds.map((_, i) => i),
                 updateBlock.characterIds.map(cid => updateBlock.characterAnnotations[cid] ?? null)]
              );
            }
            // block_tag rows are keyed by logical block_id (op.id), not by
            // snapshot_id — no copy needed during CoW.
            // （挂载边 CoW 复制已随 #420 退役：node_mount 锚稳定 block_id）
            // Update working state so subsequent ops in this patch see the new snapshotId
            cur.snapshotId = newSnapshotId;
            const oldContent = oldContentMap.get(oldSnapshotId);
            if (oldContent !== undefined && oldContent !== updateBlock.content) {
              driftUpdates.push({
                oldSnapshotId, newSnapshotId,
                oldContent, newContent: updateBlock.content,
              });
            }
          }

          // Write tags atomically within the same transaction.
          if (op.tags !== undefined) {
            await writeBlockTagsInTx(client, op.block.id, op.tags);
          }
          cur.type = nextType;
          cur.sceneId = updateBlock.sceneId ?? null;
          cur.rehearsalMark = updateBlock.rehearsalMark ?? null;
          cur.ownerMarkerId = updateBlock.ownerMarkerId ?? null;
          cur.parentMarkerId = updateBlock.markerMeta?.parentMarkerId ?? null;

          break;
        }

        case 'delete': {
          const cur = txBlockMap.get(op.id);
          if (!cur) break; // already gone — skip silently
          pageMapChanged = true;
          const idx = txBlocks.findIndex(b => b.blockId === op.id);
          const previousBlock = idx > 0 ? txBlocks[idx - 1] : null;
          if (
            !isMarkerBlockType(cur.type) &&
            previousBlock &&
            !isMarkerBlockType(previousBlock.type) &&
            updatedBlockIds?.has(previousBlock.blockId)
          ) explicitOwnershipBlockIds?.add(previousBlock.blockId);

          // Remove from version; GC orphan snapshot if no other version references it.
          // Two separate statements so the second sees the effect of the first
          // (CTE and its main query share one snapshot and cannot see each other's writes).
          await client.query(
            "DELETE FROM script_version WHERE snapshot_id = $1 AND version_id = $2",
            [cur.snapshotId, versionId]
          );
          await client.query(
            `DELETE FROM script
             WHERE id = $1
               AND NOT EXISTS (SELECT 1 FROM script_version sv WHERE sv.snapshot_id = $1)`,
            [cur.snapshotId]
          );
          // Clean up block_tag rows keyed by logical block_id.
          // Only delete when the block no longer appears in any version (i.e. the
          // script snapshot was fully GC'd above). Check by logical block_id.
          await client.query(
            `DELETE FROM block_tag
             WHERE block_id = $1
               AND NOT EXISTS (
                 SELECT 1 FROM script s
                 JOIN script_version sv ON sv.snapshot_id = s.id
                 WHERE s.block_id = $1
               )`,
            [op.id]
          );

          if (idx >= 0) txBlocks.splice(idx, 1);
          txBlockMap.delete(op.id);
          break;
        }

        case 'reorder': {
          // op.ids is the complete ordered list from the client.
          // Filter to IDs that actually exist in this version.
          const ordered = op.ids
            .map(id => txBlockMap.get(id))
            .filter((b): b is TxBlock => !!b);
          if (!ordered.length) break;
          // Assign fresh evenly-distributed keys; update only the rows that changed.
          const newKeys = initialKeys(ordered.length);
          for (let i = 0; i < ordered.length; i++) {
            if (ordered[i].lexKey !== newKeys[i]) {
              pageMapChanged = true;
              await client.query(
                "UPDATE script_version SET sort_key = $1 WHERE snapshot_id = $2 AND version_id = $3",
                [newKeys[i], ordered[i].snapshotId, versionId]
              );
              ordered[i].lexKey = newKeys[i];
            }
          }
          // Rebuild the working block list to match the new order
          txBlocks.length = 0;
          txBlocks.push(...ordered);
          break;
        }
      }
    }

    const blocksAfterPatch = blockStructureMayChange ? txBlocks.map(toBlock) : [];
    const patchBlockChange = blockStructureMayChange
      ? getMarkerChange(previousBlocks, blocksAfterPatch, movedBlockIds)
      : null;
    const normalizedServerState = patchBlockChange ? normalizeScriptMarkerInvariants({
      blocks: blocksAfterPatch,
      scenes: txScenes,
      characters: txChars,
      config: {
        ...DEFAULT_SCRIPT_CONFIG,
        openingChapterMarkerId: blocksAfterPatch.find((block) => block.type === "chapter_marker")?.id ?? null,
      },
    }, genBlockId, { mode: "scoped", ...patchBlockChange }) : null;
    const finalBlocks = normalizedServerState?.blocks ?? [];
    const repairInsertions = finalBlocks.flatMap((block, normalizedIndex) =>
      txBlockMap.has(block.id) ? [] : [{ block, normalizedIndex }]);
    for (const { block, normalizedIndex } of repairInsertions) {
      let insertAt = txBlocks.length;
      for (let index = normalizedIndex + 1; index < finalBlocks.length; index++) {
        const next = txBlockMap.get(finalBlocks[index].id);
        if (!next) continue;
        insertAt = txBlocks.indexOf(next);
        break;
      }
      const previousKey = insertAt > 0 ? txBlocks[insertAt - 1].lexKey : null;
      const nextKey = insertAt < txBlocks.length ? txBlocks[insertAt].lexKey : null;
      const lexKey = keyBetween(previousKey, nextKey);
      const snapshotId = genSnapshotId();
      const type = toDbType(block);
      const sceneId = isChapterSceneMarkerType(type) ? block.id : null;
      if (isChapterSceneMarkerType(type)) {
        await client.query(
          "INSERT INTO scene (id, production_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [block.id, productionId],
        );
      }
      await client.query(
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::block_type, $8, NULL, $9::jsonb, false)`,
        [snapshotId, block.id, productionId, lexKey, sceneId, block.ownerMarkerId ?? null, type, block.content, markerMetaJson(block)],
      );
      await client.query(
        "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) VALUES ($1, $2, $3, $4)",
        [snapshotId, versionId, block.id, lexKey],
      );
      const txBlock: TxBlock = {
        blockId: block.id,
        snapshotId,
        lexKey,
        type,
        sceneId,
        rehearsalMark: null,
        ownerMarkerId: block.ownerMarkerId ?? null,
        parentMarkerId: block.markerMeta?.parentMarkerId ?? null,
        position: insertAt,
      };
      txBlocks.splice(insertAt, 0, txBlock);
      txBlockMap.set(block.id, txBlock);
    }
    if (repairInsertions.length > 0) {
      pageMapChanged = true;
    }

    const finalBlockChange: MarkerChange = normalizedServerState ? {
      ...getMarkerChange(previousBlocks, finalBlocks, movedBlockIds),
      ownershipBlockIds: [...(explicitOwnershipBlockIds ?? [])],
    } : { changes: [], positions: [], markerStructureChanged: false };
    const markerStructureChanged = finalBlockChange.markerStructureChanged;
    const hierarchySceneMarkerIds = normalizedServerState ? (() => {
      const finalBlockById = new Map(finalBlocks.map((block) => [block.id, block]));
      return markerHierarchyUpdateBlockIds(finalBlocks, finalBlockChange).filter((id) =>
        isChapterSceneMarkerType(finalBlockById.get(id)?.type));
    })() : [];
    const affectedSceneMarkerIds = new Set([
      ...markerMetadataIds,
      ...hierarchySceneMarkerIds,
      ...dirtySceneIds,
    ]);
    const deletedSceneMarkerIds = new Set([
      ...deletedSceneIds,
      ...finalBlockChange.changes.flatMap((change) =>
        isChapterSceneMarkerType(change.beforeType) && !isChapterSceneMarkerType(change.afterType)
          ? [change.blockId]
          : []),
    ]);
    await syncSceneVersionsFromMarkersInTx(
      client,
      productionId,
      versionId,
      [...affectedSceneMarkerIds],
      [...deletedSceneMarkerIds],
    );
    pageMapDirtyPositions = [...new Set([
      ...finalBlockChange.positions,
      ...pageMapContentPositions,
    ])].filter((position) => position >= 0).sort((a, b) => a - b);
    const affectedBlockIds = normalizedServerState
      ? markerCacheUpdateBlockIds(finalBlocks, finalBlockChange)
      : [];
    if (affectedBlockIds.length > 0) {
      await normalizeRehearsalMarkOwnershipInTx(client, versionId, affectedBlockIds);
    }
    if (markerStructureChanged) {
      const openingChapterMarkerId = finalBlocks.find((block) => block.type === "chapter_marker")?.id ?? null;
      await client.query(
        "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2",
        [JSON.stringify({ openingChapterMarkerId }), versionId],
      );
      await bumpMarkerStructureRevisionInTx(client, versionId);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ── Post-commit: cue drift (best-effort, own transactions) ───────────────
  const driftJobs: Promise<void>[] = [
    ...driftDeletes.map(d =>
      handleBlockDeleted(d.snapshotId, d.prevId, d.nextId, versionId)
    ),
    ...driftUpdates.map(u =>
      handleBlockContentChanged(u.oldSnapshotId, u.newSnapshotId, u.oldContent, u.newContent, versionId)
    ),
  ];
  if (driftJobs.length > 0) await Promise.allSettled(driftJobs);

  if (pageMapChanged) {
    // ── Post-commit: update page map (fire-and-forget) ──────────────────────
    const dirty = pageMapDirtyPositions.map((start) => ({ start, end: start + 1 }));
    void scheduleEstimatedPageMapSave(productionId, versionId, dirty)
      .catch(err => console.error("[page-map] update error:", err));
  }
}

// ── Production meta ───────────────────────────────────────────────────────────

export async function updateProductionMeta(
  id: string,
  fields: { description?: string; avatarUrl?: string | null; language?: string | null; watermarkEnabled?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.description !== undefined) { sets.push(`description = $${vals.push(fields.description)}`); }
  if ("avatarUrl" in fields) { sets.push(`avatar_url = $${vals.push(fields.avatarUrl ?? null)}`); }
  if ("language" in fields) { sets.push(`language = $${vals.push(fields.language ?? null)}`); }
  if (fields.watermarkEnabled !== undefined) { sets.push(`watermark_enabled = $${vals.push(fields.watermarkEnabled)}`); }
  if (!sets.length) return;
  vals.push(id);
  await getPool().query(`UPDATE production SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

export async function updateProductionType(
  id: string,
  type: string | null,
  typeLabel: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE production SET type = $1, type_label = $2 WHERE id = $3",
    [type, typeLabel, id],
  );
}

// ─── 转发壳（#486 分家过渡期）──────────────────────────────────────────────────
// 搬出去的段只留 `export *`，让 386 个 importer 不必跟着每个搬运 PR 改路径；
// 全部搬完后最后一个 PR 脚本改写 import 到深路径并删壳。壳里不许再长函数。

export * from "./approval/access-request-db";
export * from "./approval/access-request-action-db";
export * from "./ops/milestone-db";
export * from "./notify/announcement-db";
export * from "./ops/cue-list-db";
export * from "./ops/cue-db";
export * from "./perm/role-db";
