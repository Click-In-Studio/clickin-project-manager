import { getPool } from "./pg";
import { notifyUser, notifyUsers } from "./notify";
export type { UserInfo } from "./db-feishu";
export { upsertFeishuUser, getFeishuUser, attachFeishuToUser } from "./db-feishu";
import type { UserInfo } from "./db-feishu";
import { SERVER_URL } from "./server-url";
import type { Pool, PoolClient } from "pg";
import type { Block, BlockType, Character, Scene, ScriptState, ScriptConfig, PageLayout, MarkerMeta } from "./script-types";
import { DEFAULT_SCRIPT_CONFIG, usesRehearsalMarksByDefault } from "./script-types";
import type { PermissionContext } from "./permissions";
type AtomicPermission = string;

export type ProductionAccess = {
  permCtx: PermissionContext;
  isArchived: boolean;
};
// 角色名单（ROLE_NAMES）已上移为项目模版的一个 slot，见 lib/production-template.ts
import { recomputeAndRevokeGrants, revokeAllGrantsForMember } from "./dept-db";
import {
  buildApprovalLadder, classifyApprovalNode, DEFAULT_APPROVAL_TTL_HOURS,
  expandLevelRows, nextStage, stageAt, stageStatus,
  type ApprovalStage, type ApprovalStageName, type ApprovalTarget, type StagePosition,
} from "./approval-routing";
import { isValidCustomExpiry, isValidTtlInterval } from "./approval-ttl";
import {
  approvalStageLabel, isApprovalCommentTooLong, normalizeApprovalComment,
  type ApprovalAction, type ApprovalNodeClass,
} from "./approval-stages";
import { normalizeProductionTier, type ProductionTier } from "./plan";

import type { Cue, CueAnchor } from "./cue-types";
import { adjustBlockAnchor, lcsAdjust } from "./cue-types";
import type { ScriptPatch, TagEntry } from "./script-ops";
import { keyBetween, initialKeys } from "./lex-order";
import { updateEstimatedPageMap, type EstimatedPageMapCache } from "./script-page";
import { buildMarkerLabelIndex, generatedRehearsalMarksByScene, type MarkerLabelIndex } from "./script-generated-labels";
import { VERSION_MARKER_LABEL_ROWS_SQL, VERSION_OWNED_BLOCKS_CTE, VERSION_SCENES_FROM_MARKERS_CTE } from "./script-marker-sql";
import { getMarkerChange, markerCacheUpdateBlockIds, markerHierarchyUpdateBlockIds, normalizeScriptMarkerInvariants, projectMarkers, sameMarkerStructure, type MarkerChange, type MarkerProjection } from "./script-marker-domain";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "./script-marker-blocks";
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
    await client.query(
      `INSERT INTO asset_mount
         (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
          folder_path, mount_mode, version_resolved, created_by)
       SELECT 'am_' || substr(md5(id || $1), 1, 16), asset_id, production_id,
              'block_snapshot', $1, mount_aux_id, folder_path, mount_mode,
              version_resolved, created_by
       FROM asset_mount WHERE mount_type = 'block_snapshot' AND mount_id = $2`,
      [newSnapshotId, row.snapshot_id],
    );
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
export async function loadProduction(productionId: string, versionId: string): Promise<ProductionState | null> {
  const pool = getPool();

  const [[blocksRes, scenesRes, charsRes], prodRes] = await Promise.all([
	    Promise.all([
	      pool.query<BlockRow>(
	        `SELECT
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
	         WHERE sv.version_id = $1
	         ORDER BY sv.sort_key`,
	        [versionId]
	      ),
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
    pool.query<{ production_script_config: Partial<ScriptConfig> | null; version_script_config: Partial<ScriptConfig> | null }>(
      `SELECT p.script_config AS production_script_config,
              v.script_config AS version_script_config
       FROM production p
       JOIN version v ON v.production_id = p.id
       WHERE p.id = $1 AND v.id = $2`,
      [productionId, versionId]
    ),
  ]);

  if (!prodRes.rows.length) return null;
  const rawProductionConfig = prodRes.rows[0]?.production_script_config;
  const rawVersionConfig = prodRes.rows[0]?.version_script_config;

  // script_character joins on snapshot_id (script.id)
  const snapshotIds_arr = blocksRes.rows.map(r => r.snapshot_id);
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

  const blocks: Block[] = blocksRes.rows.map(row => {
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
  const markerLabels = buildMarkerLabelIndex(blocks);

  const firstChapterMarkerId = blocks.find((block) => block.type === "chapter_marker")?.id ?? null;
  let openingChapterMarkerId =
    typeof rawVersionConfig?.openingChapterMarkerId === "string"
      ? rawVersionConfig.openingChapterMarkerId
      : null;
  const hasConfiguredOpeningChapter = !!openingChapterMarkerId &&
    blocks.some((block) => block.id === openingChapterMarkerId && block.type === "chapter_marker");
  if (!hasConfiguredOpeningChapter) {
    openingChapterMarkerId = firstChapterMarkerId;
    if (openingChapterMarkerId) {
      await pool.query(
        "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2",
        [JSON.stringify({ openingChapterMarkerId }), versionId]
      );
    }
  }
  const config: ScriptConfig = {
    ...DEFAULT_SCRIPT_CONFIG,
    ...(rawProductionConfig ?? {}),
    ...(rawVersionConfig ?? {}),
    openingChapterMarkerId,
  };

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
  const configJson = JSON.stringify({
    stageDelimOpen: config.stageDelimOpen,
    stageDelimClose: config.stageDelimClose,
    pageLayout: config.pageLayout,
    textLayoutMode: config.textLayoutMode,
    useRehearsalMarks: config.useRehearsalMarks,
  });
  const configUpdate = await pool.query<{ pagination_changed: boolean }>(
    `WITH previous AS (
       SELECT COALESCE(script_config->>'pageLayout', $3) AS page_layout,
              COALESCE(script_config->>'textLayoutMode', $4) AS text_layout_mode
       FROM production
       WHERE id = $2
     ), updated AS (
       UPDATE production SET script_config = $1 WHERE id = $2 RETURNING 1
     )
     SELECT previous.page_layout IS DISTINCT FROM $5
         OR previous.text_layout_mode IS DISTINCT FROM $6 AS pagination_changed
     FROM previous, updated`,
    [configJson, productionId, DEFAULT_SCRIPT_CONFIG.pageLayout, DEFAULT_SCRIPT_CONFIG.textLayoutMode,
      config.pageLayout, config.textLayoutMode]
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

/** Load the pre-computed page map for a production (keyed by layout → blockId → page). */
export async function loadPageMap(productionId: string): Promise<Record<string, Record<string, number>> | null> {
  const res = await getPool().query<{ page_map: Record<string, Record<string, number>> | null }>(
    "SELECT page_map FROM production WHERE id = $1",
    [productionId]
  );
  return res.rows[0]?.page_map ?? null;
}

/** Stores a pre-computed page map keyed by layout name for agent queries. */
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
          // Duplicate asset_mount entries pointing at the old snapshot
          await client.query(
            `INSERT INTO asset_mount
               (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
                folder_path, mount_mode, version_resolved, created_by)
             SELECT 'am_' || substr(md5(id || $1), 1, 16),
               asset_id, production_id, 'block_snapshot', $1, mount_aux_id,
               folder_path, mount_mode, version_resolved, created_by
             FROM asset_mount WHERE mount_type = 'block_snapshot' AND mount_id = $2`,
            [newSnapshotId, block.snapshotId]
          );
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
      // Clean up asset_mounts for snapshots that were actually GC'd
      await client.query(
        `DELETE FROM asset_mount
         WHERE mount_type = 'block_snapshot'
           AND mount_id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM script WHERE id = asset_mount.mount_id)`,
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

type ImportedCueColumn = {
  name: string;
  cues: Array<{ afterBlockId: string | null; content: string }>;
};

async function seedCueListCreatorAccessInTx(
  client: PoolClient,
  data: { id: string; productionId: string; template: string | null; createdBy: string },
): Promise<void> {
  // #236：创建者行集先过策略开关。注意 grant_source 虽写 self_confirmed，这是**创建
  // 定式**发的、不是用户点「自我确认」，故属形状 A 的论域（真正的自确认写点不接开关）。
  const { policyFilteredRows } = await import("./policy-db");
  const cueRows = await policyFilteredRows(
    data.productionId, "cue_list", "creator",
    [["*", "view"], ["*", "edit"], ["*", "delete"],
     ["cues", "create"], ["cues", "delete"], ["grants", "edit"]],
    client,
  );
  await client.query(
    `WITH creator_grants AS (
       INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT $1, $3, 'cue_list', $2, s.sub, s.verb, 'self_confirmed', $3
       FROM UNNEST($5::text[], $6::text[]) AS s(sub, verb)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING
     ), eligible_depts AS (
       -- §3.5：归属匹配改读声明表（can_create 部门）；数组列已迁移退役中
       SELECT pdm.dept_id
       FROM production_dept_member pdm
       JOIN dept_cue_list_template t
         ON t.dept_id = pdm.dept_id AND t.production_id = pdm.production_id
       WHERE pdm.user_id = $3
         AND pdm.production_id = $1
         AND t.template = $4::text AND t.can_create
     ), dept_manage AS (
       INSERT INTO resource_dept_manage
         (production_id, dept_id, resource_type, resource_id, established_by)
       SELECT $1, dept_id, 'cue_list', $2, $3 FROM eligible_depts
       ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub)
       DO NOTHING
     ), dept_permissions AS (
       INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       -- source='resource'：由该表的归属信号在管（#274），权限中心折叠只读
       SELECT $1, eligible_depts.dept_id, k.key, 'resource'
       FROM eligible_depts
       CROSS JOIN (VALUES
         ('node:cue_list/' || $2 || '@view'),
         ('node:cue_list/' || $2 || '@edit'),
         ('node:cue_list/' || $2 || '/cues@create'),
         ('node:cue_list/' || $2 || '/cues@delete')
       ) AS k(key)
       ON CONFLICT (dept_id, permission_key) DO NOTHING
     )
     INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, established_by)
     SELECT $1, $3, 'cue_list', $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM eligible_depts)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [data.productionId, data.id, data.createdBy, data.template,
     cueRows.map((r) => r[0]), cueRows.map((r) => r[1])],
  );
}

async function importCueColumnsInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
  createdBy: string,
  columns: ImportedCueColumn[],
): Promise<void> {
  const existingLists = await client.query<{ id: string; name: string; template: string | null }>(
    "SELECT id, name, template FROM cue_list WHERE production_id = $1 ORDER BY created_at",
    [productionId],
  );
  const normalizedKey = (value: string) => value.trim().toLocaleLowerCase();
  const listByKey = new Map<string, { id: string; name: string; template: string | null }>();
  for (const list of existingLists.rows) {
    listByKey.set(normalizedKey(list.name), list);
    if (list.template) listByKey.set(normalizedKey(list.template), list);
  }

  const resolvedColumns: Array<ImportedCueColumn & { listId: string }> = [];
  for (const column of columns) {
    const key = normalizedKey(column.name);
    let list = listByKey.get(key);
    if (!list) {
      const id = `cl${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      // #227：模版类型读 production 级注册表
      const typeRows = await client.query<{ key: string }>(
        "SELECT key FROM production_cue_template_type WHERE production_id = $1",
        [productionId],
      );
      const template = typeRows.rows.find((t) => normalizedKey(t.key) === key)?.key ?? null;
      await client.query(
        `INSERT INTO cue_list (id, production_id, name, notes, abbr, template, created_by)
         VALUES ($1, $2, $3, '', NULL, $4, $5)`,
        [id, productionId, column.name, template, createdBy],
      );
      await seedCueListCreatorAccessInTx(client, { id, productionId, template, createdBy });
      if (template) {
        const { applyCueTemplateGrants } = await import("./cue-template-db");
        await applyCueTemplateGrants(client, productionId, id, template);
      }
      list = { id, name: column.name, template };
      listByKey.set(key, list);
    }
    resolvedColumns.push({ ...column, listId: list.id });
  }

  const afterBlockIds = [...new Set(resolvedColumns.flatMap((column) =>
    column.cues.flatMap((cue) => cue.afterBlockId ? [cue.afterBlockId] : []),
  ))];
  const snapshotByBlockId = new Map<string, string>();
  if (afterBlockIds.length > 0) {
    const snapshots = await client.query<{ block_id: string; snapshot_id: string }>(
      `SELECT block_id, snapshot_id
       FROM script_version
       WHERE version_id = $1 AND block_id = ANY($2::text[])`,
      [versionId, afterBlockIds],
    );
    for (const row of snapshots.rows) snapshotByBlockId.set(row.block_id, row.snapshot_id);
    const missingBlockId = afterBlockIds.find((blockId) => !snapshotByBlockId.has(blockId));
    if (missingBlockId) throw new Error(`Imported Cue anchor block is missing: ${missingBlockId}`);
  }

  const listIds = [...new Set(resolvedColumns.map((column) => column.listId))];
  const existingNumbers = listIds.length > 0
    ? await client.query<{ cue_list_id: string; number: string }>(
        "SELECT cue_list_id, number FROM cue WHERE cue_list_id = ANY($1::text[])",
        [listIds],
      )
    : { rows: [] as Array<{ cue_list_id: string; number: string }> };
  const usedNumbersByList = new Map<string, Set<string>>();
  for (const row of existingNumbers.rows) {
    const used = usedNumbersByList.get(row.cue_list_id) ?? new Set<string>();
    used.add(row.number);
    usedNumbersByList.set(row.cue_list_id, used);
  }

  const cueRows: Array<{
    id: string;
    listId: string;
    number: string;
    content: string;
    snapshotId: string | null;
  }> = [];
  for (const column of resolvedColumns) {
    const usedNumbers = usedNumbersByList.get(column.listId) ?? new Set<string>();
    usedNumbersByList.set(column.listId, usedNumbers);
    let nextNumber = 1;
    for (const cue of column.cues) {
      while (usedNumbers.has(String(nextNumber))) nextNumber++;
      const number = String(nextNumber++);
      usedNumbers.add(number);
      const id = `cue${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      const snapshotId = cue.afterBlockId ? snapshotByBlockId.get(cue.afterBlockId)! : null;
      cueRows.push({ id, listId: column.listId, number, content: cue.content.trim(), snapshotId });
    }
  }
  if (cueRows.length === 0) return;
  await client.query(
    `INSERT INTO cue (
       id, cue_id, cue_list_id, number, name, content,
       start_kind, start_snapshot_id, start_offset,
       end_kind, end_snapshot_id, end_offset
     )
     SELECT imported.id, imported.id, imported.list_id, imported.number, '', imported.content,
            'gap', imported.snapshot_id, NULL, 'gap', imported.snapshot_id, NULL
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
       AS imported(id, list_id, number, content, snapshot_id)`,
    [
      cueRows.map(row => row.id),
      cueRows.map(row => row.listId),
      cueRows.map(row => row.number),
      cueRows.map(row => row.content),
      cueRows.map(row => row.snapshotId),
    ],
  );
  await client.query(
    `INSERT INTO cue_version (revision_id, version_id, cue_id)
     SELECT cue_id, $2::text, cue_id FROM unnest($1::text[]) AS imported(cue_id)`,
    [cueRows.map(row => row.id), versionId],
  );
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
   *  （internal owner 建项即最高档）与本体同事务落行。档位决策在路由层（lib/plan.ts）。 */
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
  const { applyProductionTemplate } = await import("./production-template");
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
    // 建项目的全部初始状态——角色名单、部门树、部门静态区间键、cue 模版体系的初始行、
    // 策略档位、审批 TTL——统一由项目模版按类型灌入。
    // 见 lib/production-template.ts（模版是代码常量：改它＝改代码＝走 PR）。
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
  const { listCreatableTemplates } = await import("./cue-template-db");
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
    await client.query(`UPDATE asset_mount SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE asset_share_token SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
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
  /** 注册邀请制（lib/registration-gate.ts）：正当性是邀请码时传入，在建号事务内
   *  锁行消耗 + 落流水；并发用尽则整个事务回滚，不产生账号。老用户路径不触码。 */
  registrationCode?: string,
): Promise<{ userId: string }> {
  // 防御性归一（review #308 finding 1）：email 身份全库约定存小写（两个写点的
  // 路由各自 lower 过），在唯一的账号创建入口把不变量收为本地——大小写变体
  // 不可能绕过注册门检查或裂出重复账号。
  email = email.trim().toLowerCase();
  const { consumeRegistrationCode } = await import("./registration-gate");
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
 * templates from lib/permissions.ts when the production has no role records yet.
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
// 唯一的移出路径是 lib/member-status.ts 的 suspend → confirmMemberExit：撤销授权、
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
// 人事停用）。状态机的唯一写点是 lib/member-status.ts，端点见
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

// ─── Cue lists ────────────────────────────────────────────────────────────────

import type { CueList, CueListPermissionRow } from "./cue-list-types";
import type { MemberStatus, MemberStatusSource } from "./member-status-shared";

type CueListRow = {
  id: string; production_id: string; name: string; notes: string;
  abbr: string | null; template: string | null;
  created_by: string; created_by_name: string; created_at: Date;
};

function rowToCueList(r: CueListRow): CueList {
  return {
    id: r.id, productionId: r.production_id, name: r.name, notes: r.notes,
    abbr: r.abbr, template: r.template,
    createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listCueLists(productionId: string): Promise<CueList[]> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.created_by, COALESCE(up.name, '') AS created_by_name, cl.created_at
     FROM cue_list cl
     LEFT JOIN user_profile up ON up.user_id = cl.created_by
     WHERE cl.production_id = $1
     ORDER BY cl.created_at`,
    [productionId]
  );
  return res.rows.map(rowToCueList);
}

/**
 * Returns cue lists for a production with per-list canEdit/canManage（批A REST 语义）。
 * 目录三态：seeAll=false 时只返回用户持有 meta/cues view 行（含通配）的表；
 * seeAll=true（admin/owner）返回全量。
 * canEdit = 覆盖 cues 的 edit 行；canManage = 显式 grants edit 行。
 */
export async function listCueListsWithAccess(
  productionId: string,
  userId: string,
  opts: { seeAll?: boolean } = {},
): Promise<(CueList & { canEdit: boolean; canManage: boolean })[]> {
  const res = await getPool().query<CueListRow & { can_edit: boolean; can_manage: boolean }>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.created_by, COALESCE(up.name, '') AS created_by_name, cl.created_at,
            EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.production_id = cl.production_id
                AND rg.resource_type = 'cue_list'
                AND rg.resource_id IN (cl.id, '*')
                AND rg.resource_sub IN ('cues', '*')
                AND rg.permission_level = 'edit'
                AND rg.user_id = $2
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
            ) AS can_edit,
            EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.production_id = cl.production_id
                AND rg.resource_type = 'cue_list'
                AND rg.resource_id IN (cl.id, '*')
                AND rg.resource_sub = 'grants'
                AND rg.permission_level = 'edit'
                AND rg.user_id = $2
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
            ) AS can_manage
     FROM cue_list cl
     LEFT JOIN user_profile up ON up.user_id = cl.created_by
     WHERE cl.production_id = $1
       AND ($3 OR EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.production_id = cl.production_id
                AND rg.resource_type = 'cue_list'
                AND rg.resource_id IN (cl.id, '*')
                AND rg.resource_sub IN ('meta', 'cues', '*')
                AND rg.permission_level = 'view'
                AND rg.user_id = $2
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
            ))
     ORDER BY cl.created_at`,
    [productionId, userId, opts.seeAll === true],
  );
  return res.rows.map((r) => ({ ...rowToCueList(r), canEdit: r.can_edit, canManage: r.can_manage }));
}

export async function listProductionDepts(
  productionId: string,
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await getPool().query<{ id: string; name: string }>(
    `SELECT id, name FROM production_dept WHERE production_id = $1 ORDER BY display_order, name`,
    [productionId],
  );
  return rows;
}

export async function createCueList(data: {
  id: string; productionId: string; name: string; notes: string;
  abbr: string | null; template: string | null; createdBy: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cue_list (id, production_id, name, notes, abbr, template, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [data.id, data.productionId, data.name, data.notes, data.abbr, data.template, data.createdBy],
    );
    await seedCueListCreatorAccessInTx(client, data);
    // §3.5 受益发键定式：∀ (dept, template) 声明行 → 实例区间键
    if (data.template) {
      const { applyCueTemplateGrants } = await import("./cue-template-db");
      await applyCueTemplateGrants(client, data.productionId, data.id, data.template);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCueList(id: string, productionId: string): Promise<CueList | null> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.created_by, COALESCE(up.name, '') AS created_by_name, cl.created_at
     FROM cue_list cl
     LEFT JOIN user_profile up ON up.user_id = cl.created_by
     WHERE cl.id = $1 AND cl.production_id = $2`,
    [id, productionId]
  );
  if (!res.rows.length) return null;
  return rowToCueList(res.rows[0]);
}

/** Returns the set of role names defined for a production (from production_role table). */
export async function getProductionRoleNames(productionId: string): Promise<Set<string>> {
  const res = await getPool().query<{ name: string }>(
    `SELECT name FROM production_role WHERE production_id = $1`,
    [productionId],
  );
  return new Set(res.rows.map((r) => r.name));
}

/** Resolves role names to production_role IDs for the given production. */
export async function resolveRoleIdsByNames(productionId: string, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const res = await getPool().query<{ id: string }>(
    `SELECT id FROM production_role WHERE production_id = $1 AND name = ANY($2)`,
    [productionId, names]
  );
  return res.rows.map(r => r.id);
}

// ─── Role CRUD (admin panel) ───────────────────────────────────────────────────

export type ProductionRole = {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
};

export async function listProductionRolesWithPermissions(productionId: string): Promise<ProductionRole[]> {
  const [rolesRes, permsRes] = await Promise.all([
    getPool().query<{ id: string; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM production_role WHERE production_id = $1 ORDER BY name`,
      [productionId],
    ),
    getPool().query<{ role_id: string; permission_key: string }>(
      `SELECT prp.role_id, prp.permission_key
       FROM production_role_permission prp
       JOIN production_role pr ON pr.id = prp.role_id
       WHERE pr.production_id = $1`,
      [productionId],
    ),
  ]);
  const permMap = new Map<string, string[]>();
  for (const r of permsRes.rows) {
    const list = permMap.get(r.role_id) ?? [];
    list.push(r.permission_key);
    permMap.set(r.role_id, list);
  }
  return rolesRes.rows.map((r) => ({
    id: r.id, name: r.name,
    permissions: permMap.get(r.id) ?? [],
    createdAt: r.created_at.toISOString(),
  }));
}

let _roleSeq = 0;
function newRoleId(productionId: string) {
  return `r_${productionId.slice(0, 8)}_${Date.now().toString(36)}${(++_roleSeq).toString(36)}`;
}

export async function createProductionRole(productionId: string, name: string): Promise<ProductionRole> {
  const id = newRoleId(productionId);
  const res = await getPool().query<{ id: string; name: string; created_at: Date }>(
    `INSERT INTO production_role (id, production_id, name)
     VALUES ($1, $2, $3) RETURNING id, name, created_at`,
    [id, productionId, name],
  );
  const row = res.rows[0];
  // 自定义角色也获得基线键；名字命中本项目模版里的角色则一并 seed 那份。
  // 这仍是「创建时 seed」而非运行时读模版——判定端一行都不查模版。
  const prodType = (await getPool().query<{ type: string | null }>(
    "SELECT type FROM production WHERE id = $1", [productionId],
  )).rows[0]?.type ?? null;
  const { resolveTemplate } = await import("./production-template");
  const { roleKeys } = await import("./template-seeders/roles");
  const keys = roleKeys(resolveTemplate(prodType).roles, name);
  if (keys.length > 0) {
    await getPool().query(
      `INSERT INTO production_role_permission (role_id, permission_key)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [row.id, keys],
    );
  }
  const seeded = await getPool().query<{ permission_key: string }>(
    "SELECT permission_key FROM production_role_permission WHERE role_id = $1", [row.id],
  );
  return { id: row.id, name: row.name, permissions: seeded.rows.map((r) => r.permission_key), createdAt: row.created_at.toISOString() };
}

export async function renameProductionRole(roleId: string, productionId: string, name: string): Promise<void> {
  // 批G：制作人 role 身份不可变（改名后"防止移除"即名存实亡）
  const cur = await getPool().query<{ name: string }>(
    "SELECT name FROM production_role WHERE id = $1 AND production_id = $2", [roleId, productionId]);
  if (cur.rows[0]?.name === "制作人") throw new Error("制作人角色不可改名");

  await getPool().query(
    `UPDATE production_role SET name = $1 WHERE id = $2 AND production_id = $3`,
    [name, roleId, productionId],
  );
}

export async function deleteProductionRole(roleId: string, productionId: string): Promise<void> {
  // 批G：制作人 role 是结构性角色（通配区间宿主、seed/迁移按名匹配）——不可删除
  const res = await getPool().query(
    `DELETE FROM production_role WHERE id = $1 AND production_id = $2 AND name != '制作人'
     RETURNING id`,
    [roleId, productionId],
  );
  if (res.rows.length === 0) {
    const exists = await getPool().query(
      "SELECT 1 FROM production_role WHERE id = $1 AND production_id = $2", [roleId, productionId]);
    if (exists.rows.length > 0) throw new Error("制作人角色不可删除");
  }
}

export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM production_role_permission WHERE role_id = $1`, [roleId]);
    if (permissions.length > 0) {
      await client.query(
        `INSERT INTO production_role_permission (role_id, permission_key)
         SELECT $1, unnest($2::text[])`,
        [roleId, permissions],
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

export async function copyProductionRole(productionId: string, sourceRoleId: string, newName: string): Promise<ProductionRole> {
  const pool = getPool();
  const newId = newRoleId(productionId);
  const sourcePerms = await pool.query<{ permission_key: string }>(
    `SELECT permission_key FROM production_role_permission WHERE role_id = $1`,
    [sourceRoleId],
  );
  const permissions = sourcePerms.rows.map((r) => r.permission_key);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ created_at: Date }>(
      `INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3) RETURNING created_at`,
      [newId, productionId, newName],
    );
    if (permissions.length > 0) {
      await client.query(
        `INSERT INTO production_role_permission (role_id, permission_key)
         SELECT $1, unnest($2::text[])`,
        [newId, permissions],
      );
    }
    await client.query("COMMIT");
    return { id: newId, name: newName, permissions, createdAt: res.rows[0].created_at.toISOString() };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Returns true if the user can edit this cue list（批A REST 语义）：
 * 持有 (id|'*') 上覆盖 cues 的 edit 动词行（'*' 整树或显式 cues）。
 * 存量 edit 行（sub='*' level='edit'）天然是合法树行；原 manage 行经迁移拆解。
 */
export async function hasListAccess(cueListId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ has_access: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM production_member_grant rg
       JOIN cue_list cl ON cl.id = $1 AND cl.production_id = rg.production_id
       WHERE rg.resource_type = 'cue_list'
         AND rg.resource_id IN ($1, '*')
         AND rg.resource_sub IN ('cues', '*')
         AND rg.permission_level = 'edit'
         AND rg.user_id = $2
         AND NOT rg.is_revoked
         AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ) AS has_access`,
    [cueListId, userId],
  );
  return res.rows[0]?.has_access === true;
}

/**
 * Returns user IDs of all members with active edit or manage grants on a cue list.
 * Used for cue warning notifications.
 */
export async function listCueListRoleMembers(cueListId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT rg.user_id
     FROM production_member_grant rg
     WHERE rg.resource_type = 'cue_list'
       AND rg.resource_id = $1
       AND rg.resource_sub IN ('cues', '*')
       AND rg.permission_level = 'edit'
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())`,
    [cueListId],
  );
  return res.rows.map((r) => r.user_id);
}

export async function updateCueList(
  id: string, productionId: string,
  fields: { name?: string; notes?: string; abbr?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, productionId];
  if (fields.name  !== undefined) sets.push(`name  = $${vals.push(fields.name)}`);
  if (fields.notes !== undefined) sets.push(`notes = $${vals.push(fields.notes)}`);
  if ("abbr" in fields) sets.push(`abbr = $${vals.push(fields.abbr ?? null)}`);
  if (!sets.length) return;
  await getPool().query(
    `UPDATE cue_list SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`,
    vals
  );
}

export async function deleteCueList(id: string, productionId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM cue_list WHERE id = $1 AND production_id = $2",
    [id, productionId]
  );
}

export async function listCueListPermissions(cueListId: string): Promise<CueListPermissionRow[]> {
  const res = await getPool().query<{ user_id: string; permission_level: string }>(
    `SELECT DISTINCT rg.user_id, rg.permission_level
     FROM production_member_grant rg
     WHERE rg.resource_type = 'cue_list'
       AND rg.resource_id = $1
       AND rg.resource_sub IN ('cues', '*')
       AND rg.permission_level = 'edit'
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ORDER BY rg.user_id`,
    [cueListId],
  );
  return res.rows.map((r) => ({ userId: r.user_id, canEdit: true }));
}

export async function setCueListPermission(
  cueListId: string,
  userId: string,
  canEdit: boolean | null,
  grantedBy?: string,
): Promise<void> {
  if (canEdit === true) {
    // 批A：编辑授权 = 动词行集（view + edit + cues create/delete）
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT cl.production_id, $2, 'cue_list', $1, s.sub, s.verb, 'direct', $3
       FROM cue_list cl,
            (VALUES ('*', 'view'), ('*', 'edit'), ('cues', 'create'), ('cues', 'delete')) AS s(sub, verb)
       WHERE cl.id = $1
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [cueListId, userId, grantedBy ?? null],
    );
  } else {
    await getPool().query(
      `UPDATE production_member_grant
       SET is_revoked = true, revoked_reason = 'manual'
       WHERE resource_type = 'cue_list'
         AND resource_id = $1
         AND user_id = $2
         AND NOT is_revoked`,
      [cueListId, userId],
    );
  }
}

// ─── Cues ─────────────────────────────────────────────────────────────────────

// After migration: start_block_id/end_block_id are renamed to start_snapshot_id/end_snapshot_id.
// The row also has start_block_id/end_block_id as computed aliases from the JOIN with script table.
type CueRow = {
  id: string; cue_id: string; cue_list_id: string; number: string; name: string; content: string;
  start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
  end_kind: string;   end_snapshot_id: string | null;   end_offset: number | null;
  // Logical block IDs resolved by joining script table (may be null if snapshot deleted)
  start_block_id: string | null;
  end_block_id: string | null;
  warning: boolean;
};

function rowToCue(r: CueRow): Cue {
  const start: CueAnchor = r.start_kind === "gap"
    ? { kind: "gap", afterBlockId: r.start_block_id ?? null }
    : { kind: "block", blockId: r.start_block_id ?? r.start_snapshot_id ?? '', offset: r.start_offset! };
  const end: CueAnchor = r.end_kind === "gap"
    ? { kind: "gap", afterBlockId: r.end_block_id ?? null }
    : { kind: "block", blockId: r.end_block_id ?? r.end_snapshot_id ?? '', offset: r.end_offset! };
  return { id: r.id, cueId: r.cue_id, cueListId: r.cue_list_id, number: r.number, name: r.name, content: r.content, start, end, warning: r.warning };
}

// Resolve a CueAnchor to the snapshot_id stored in the DB.
// For the initial migration: snapshot_id = block_id. After CoW, lookup is needed.
async function anchorToDb(a: CueAnchor, versionId?: string): Promise<{ kind: string; snapshotId: string | null; offset: number | null }> {
  if (a.kind === "gap") {
    if (a.afterBlockId === null) return { kind: "gap", snapshotId: null, offset: null };
    if (versionId) {
      const res = await getPool().query<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM script_version WHERE block_id = $1 AND version_id = $2 LIMIT 1",
        [a.afterBlockId, versionId]
      );
      return { kind: "gap", snapshotId: res.rows[0]?.snapshot_id ?? a.afterBlockId, offset: null };
    }
    return { kind: "gap", snapshotId: a.afterBlockId, offset: null };
  }
  if (versionId) {
    const res = await getPool().query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM script_version WHERE block_id = $1 AND version_id = $2 LIMIT 1",
      [a.blockId, versionId]
    );
    return { kind: "block", snapshotId: res.rows[0]?.snapshot_id ?? a.blockId, offset: a.offset };
  }
  return { kind: "block", snapshotId: a.blockId, offset: a.offset };
}

const CUE_SELECT = `
  SELECT c.id, c.cue_id, c.cue_list_id, c.number, c.name, c.content,
         c.start_kind, c.start_snapshot_id, c.start_offset,
         c.end_kind,   c.end_snapshot_id,   c.end_offset, c.warning,
         s_start.block_id AS start_block_id,
         s_end.block_id   AS end_block_id
  FROM cue c
  LEFT JOIN script s_start ON s_start.id = c.start_snapshot_id
  LEFT JOIN script s_end   ON s_end.id   = c.end_snapshot_id
`;

export async function getCue(id: string, cueListId: string): Promise<Cue | null> {
  const res = await getPool().query<CueRow>(
    `${CUE_SELECT} WHERE c.id = $1 AND c.cue_list_id = $2`,
    [id, cueListId]
  );
  return res.rows.length ? rowToCue(res.rows[0]) : null;
}

/** cue → 所属 cue_list（production 归属校验内含）。cue 级权限门都长在 cue_list 上，
 *  拿到宿主 list id 才能过门（wiki-refs 等只有 cueId 的入口用）。
 *  入参是**稳定 cue_id**（#302 换锚后引用侧一律持它）；一个逻辑 cue 的多条修订
 *  同属一张 list（cowCue 逐字继承 cue_list_id），故 LIMIT 1 取哪条都一样。 */
export async function getCueListIdForCue(cueId: string, productionId: string): Promise<string | null> {
  const res = await getPool().query<{ cue_list_id: string }>(
    `SELECT c.cue_list_id FROM cue c
     JOIN cue_list cl ON cl.id = c.cue_list_id
     WHERE c.cue_id = $1 AND cl.production_id = $2
     LIMIT 1`,
    [cueId, productionId],
  );
  return res.rows[0]?.cue_list_id ?? null;
}

export async function listCues(cueListId: string, versionId?: string): Promise<Cue[]> {
  if (versionId) {
    const res = await getPool().query<CueRow>(
      `${CUE_SELECT}
       WHERE c.cue_list_id = $1
         AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $2)
       ORDER BY c.number`,
      [cueListId, versionId]
    );
    return res.rows.map(rowToCue);
  }
  const res = await getPool().query<CueRow>(
    `${CUE_SELECT} WHERE c.cue_list_id = $1 ORDER BY c.number`,
    [cueListId]
  );
  return res.rows.map(rowToCue);
}

export async function listCuesByProduction(productionId: string, versionId?: string): Promise<Cue[]> {
  if (versionId) {
    const res = await getPool().query<CueRow>(
      `${CUE_SELECT}
       JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE cl.production_id = $1
         AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $2)
       ORDER BY c.number`,
      [productionId, versionId]
    );
    return res.rows.map(rowToCue);
  }
  const res = await getPool().query<CueRow>(
    `${CUE_SELECT}
     JOIN cue_list cl ON cl.id = c.cue_list_id
     WHERE cl.production_id = $1
     ORDER BY c.number`,
    [productionId]
  );
  return res.rows.map(rowToCue);
}

export async function countWarningCues(cueListIds: string[]): Promise<number> {
  if (cueListIds.length === 0) return 0;
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue WHERE cue_list_id = ANY($1::text[]) AND warning = TRUE`,
    [cueListIds]
  );
  return parseInt(res.rows[0].count, 10);
}

export async function countCueWarningsForProduction(
  productionId: string,
  userId: string,
  isAdmin: boolean,
): Promise<number> {
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue c
     JOIN cue_list cl ON c.cue_list_id = cl.id
     WHERE cl.production_id = $1 AND c.warning = TRUE
       AND ($2 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = cl.production_id AND pm.user_id = $3
           AND pm.status = 'active'
       ))`,
    [productionId, isAdmin, userId]
  );
  return parseInt(res.rows[0].count, 10);
}

export async function createCue(data: {
  id: string; cueListId: string; number: string; name: string; content: string;
  start: CueAnchor; end: CueAnchor; versionId?: string;
}): Promise<void> {
  const s = await anchorToDb(data.start, data.versionId);
  const e = await anchorToDb(data.end, data.versionId);
  await getPool().query(
    `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
       start_kind, start_snapshot_id, start_offset,
       end_kind,   end_snapshot_id,   end_offset)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [data.id, data.cueListId, data.number, data.name, data.content,
     s.kind, s.snapshotId, s.offset, e.kind, e.snapshotId, e.offset]
  );
  if (data.versionId) {
    await getPool().query(
      "INSERT INTO cue_version (revision_id, version_id, cue_id) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING",
      [data.id, data.versionId]
    );
  }
}

let _cueSeq = 0;
const newCueId = () => `cue${Date.now().toString(36)}${(++_cueSeq).toString(36)}`;

export async function updateCue(
  id: string, cueListId: string,
  fields: { number?: string; name?: string; content?: string; start?: CueAnchor; end?: CueAnchor; warning?: boolean },
  versionId?: string
): Promise<void> {
  // Resolve anchors outside transaction (async DB lookups)
  const resolvedStart = fields.start !== undefined ? await anchorToDb(fields.start, versionId) : undefined;
  const resolvedEnd   = fields.end   !== undefined ? await anchorToDb(fields.end,   versionId) : undefined;

  const buildInPlaceUpdate = () => {
    const sets: string[] = [];
    const vals: unknown[] = [id, cueListId];
    if (fields.number  !== undefined) sets.push(`number  = $${vals.push(fields.number)}`);
    if (fields.name    !== undefined) sets.push(`name    = $${vals.push(fields.name)}`);
    if (fields.content !== undefined) sets.push(`content = $${vals.push(fields.content)}`);
    if (fields.warning !== undefined) sets.push(`warning = $${vals.push(fields.warning)}`);
    if (resolvedStart) {
      const s = resolvedStart;
      sets.push(`start_kind=$${vals.push(s.kind)}, start_snapshot_id=$${vals.push(s.snapshotId)}, start_offset=$${vals.push(s.offset)}`);
    }
    if (resolvedEnd) {
      const e = resolvedEnd;
      sets.push(`end_kind=$${vals.push(e.kind)}, end_snapshot_id=$${vals.push(e.snapshotId)}, end_offset=$${vals.push(e.offset)}`);
    }
    return { sets, vals };
  };

  if (!versionId) {
    const { sets, vals } = buildInPlaceUpdate();
    if (!sets.length) return;
    await getPool().query(`UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`, vals);
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const refRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [id]
    );
    const refCount = parseInt(refRes.rows[0].count, 10);

    if (refCount <= 1) {
      const { sets, vals } = buildInPlaceUpdate();
      if (sets.length) await client.query(`UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`, vals);
    } else {
      // CoW: fork a new physical row for versionId（共享修订属于遗留多版本数据，只读保护）
      const curRes = await client.query<{
        number: string; name: string; content: string; warning: boolean; cue_id: string | null;
        start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
        end_kind: string; end_snapshot_id: string | null; end_offset: number | null;
      }>(
        `SELECT number, name, content, warning, cue_id,
                start_kind, start_snapshot_id, start_offset,
                end_kind, end_snapshot_id, end_offset
         FROM cue WHERE id = $1 AND cue_list_id = $2`,
        [id, cueListId]
      );
      if (!curRes.rows.length) { await client.query("ROLLBACK"); return; }
      const cur = curRes.rows[0];

      const newId = newCueId();
      await client.query(
        `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
           start_kind, start_snapshot_id, start_offset,
           end_kind,   end_snapshot_id,   end_offset, warning)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          newId, cur.cue_id ?? id, cueListId,
          fields.number  !== undefined ? fields.number  : cur.number,
          fields.name    !== undefined ? fields.name    : cur.name,
          fields.content !== undefined ? fields.content : cur.content,
          resolvedStart ? resolvedStart.kind       : cur.start_kind,
          resolvedStart ? resolvedStart.snapshotId : cur.start_snapshot_id,
          resolvedStart ? resolvedStart.offset     : cur.start_offset,
          resolvedEnd   ? resolvedEnd.kind         : cur.end_kind,
          resolvedEnd   ? resolvedEnd.snapshotId   : cur.end_snapshot_id,
          resolvedEnd   ? resolvedEnd.offset       : cur.end_offset,
          fields.warning !== undefined ? fields.warning : cur.warning,
        ]
      );

      // Remap cue_version for versionId only（线性化后 head 无子孙，不存在级联目标）
      await client.query(
        "UPDATE cue_version SET revision_id = $1 WHERE revision_id = $2 AND version_id = $3",
        [newId, id, versionId]
      );
      // Copy cue_revision asset mounts to the new revision (mirrors cowCue behaviour)
      await client.query(
        `INSERT INTO asset_mount
           (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
            folder_path, mount_mode, version_resolved, created_by)
         SELECT 'am_' || substr(md5(id || $1), 1, 16),
           asset_id, production_id, 'cue_revision', $1, mount_aux_id,
           folder_path, mount_mode, version_resolved, created_by
         FROM asset_mount WHERE mount_type = 'cue_revision' AND mount_id = $2`,
        [newId, id]
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

export async function deleteCue(id: string, cueListId: string, versionId?: string): Promise<void> {
  if (!versionId) {
    await getPool().query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Remove cue_version for versionId only（线性化后 head 无子孙）
    await client.query(
      "DELETE FROM cue_version WHERE revision_id = $1 AND version_id = $2",
      [id, versionId]
    );
    // Delete the physical row only if no version references it anymore
    const refRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [id]
    );
    if (parseInt(refRes.rows[0].count, 10) === 0) {
      await client.query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
      await client.query(
        "DELETE FROM asset_mount WHERE mount_type = 'cue_revision' AND mount_id = $1", [id]
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

// ── CoW helper: fork a cue revision for a version and remap cue_version ──────

type CueFullRow = {
  id: string; cue_id: string | null; cue_list_id: string;
  number: string; name: string; content: string; warning: boolean;
  start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
  end_kind: string; end_snapshot_id: string | null; end_offset: number | null;
};

/** Insert a new physical cue row that is a copy of `cur` with `patch` applied,
 *  then remap cue_version for `versionId` from old to new id.
 *  Must be called inside an open transaction on `client`. Returns the new revision id. */
async function cowCue(
  client: PoolClient,
  versionId: string,
  cur: CueFullRow,
  patch: Partial<Pick<CueFullRow, "start_kind"|"start_snapshot_id"|"start_offset"|
                                  "end_kind"|"end_snapshot_id"|"end_offset"|"warning">>
): Promise<string> {
  const newId = newCueId();
  await client.query(
    `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
       start_kind, start_snapshot_id, start_offset,
       end_kind,   end_snapshot_id,   end_offset, warning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      newId, cur.cue_id ?? cur.id, cur.cue_list_id, cur.number, cur.name, cur.content,
      patch.start_kind        ?? cur.start_kind,
      patch.start_snapshot_id ?? cur.start_snapshot_id,
      patch.start_offset      !== undefined ? patch.start_offset : cur.start_offset,
      patch.end_kind          ?? cur.end_kind,
      patch.end_snapshot_id   ?? cur.end_snapshot_id,
      patch.end_offset        !== undefined ? patch.end_offset : cur.end_offset,
      patch.warning           !== undefined ? patch.warning : cur.warning,
    ]
  );
  await client.query(
    "UPDATE cue_version SET revision_id = $1 WHERE revision_id = $2 AND version_id = $3",
    [newId, cur.id, versionId]
  );
  // Duplicate asset_mount entries pointing at the old revision
  await client.query(
    `INSERT INTO asset_mount
       (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
        folder_path, mount_mode, version_resolved, created_by)
     SELECT 'am_' || substr(md5(id || $1), 1, 16),
       asset_id, production_id, 'cue_revision', $1, mount_aux_id,
       folder_path, mount_mode, version_resolved, created_by
     FROM asset_mount WHERE mount_type = 'cue_revision' AND mount_id = $2`,
    [newId, cur.id]
  );
  return newId;
}

/** Apply `patch` to a cue revision with CoW if the revision is shared.
 *  Returns the (possibly new) revision id. */
async function applyPatchWithCow(
  client: PoolClient,
  versionId: string,
  cur: CueFullRow,
  patch: Parameters<typeof cowCue>[3]
): Promise<string> {
  const refRes = await client.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [cur.id]
  );
  if (parseInt(refRes.rows[0].count, 10) <= 1) {
    // Single reference — update in place
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.start_kind        !== undefined) { sets.push(`start_kind=$${vals.push(patch.start_kind)}`); }
    if (patch.start_snapshot_id !== undefined) { sets.push(`start_snapshot_id=$${vals.push(patch.start_snapshot_id)}`); }
    if ("start_offset" in patch) { sets.push(`start_offset=$${vals.push(patch.start_offset ?? null)}`); }
    if (patch.end_kind          !== undefined) { sets.push(`end_kind=$${vals.push(patch.end_kind)}`); }
    if (patch.end_snapshot_id   !== undefined) { sets.push(`end_snapshot_id=$${vals.push(patch.end_snapshot_id)}`); }
    if ("end_offset" in patch) { sets.push(`end_offset=$${vals.push(patch.end_offset ?? null)}`); }
    if (patch.warning !== undefined) { sets.push(`warning=$${vals.push(patch.warning)}`); }
    if (sets.length) {
      vals.push(cur.id);
      await client.query(`UPDATE cue SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    }
    return cur.id;
  }
  return cowCue(client, versionId, cur, patch);
}

/** Remove a cue revision from a version with CoW semantics.
 *  Must be called inside an open transaction. */
async function removeCueFromVersion(
  client: PoolClient,
  versionId: string,
  revisionId: string
): Promise<void> {
  const refRes = await client.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [revisionId]
  );
  if (parseInt(refRes.rows[0].count, 10) <= 1) {
    await client.query("DELETE FROM cue WHERE id = $1", [revisionId]);
    await client.query(
      "DELETE FROM asset_mount WHERE mount_type = 'cue_revision' AND mount_id = $1", [revisionId]
    );
  } else {
    await client.query(
      "DELETE FROM cue_version WHERE revision_id = $1 AND version_id = $2",
      [revisionId, versionId]
    );
  }
}

/**
 * Called when a snapshot is deleted from a version.
 * Re-anchors (or removes) cue revisions in the affected version with CoW semantics.
 */
export async function handleBlockDeleted(
  deletedSnapshotId: string,
  prevSnapshotId: string | null,
  nextSnapshotId: string | null,
  versionId: string,
): Promise<void> {
  // Find cues in this version anchoring to the deleted snapshot
  const affected = await getPool().query<CueFullRow>(
    `SELECT cue.id, cue.cue_id, cue.cue_list_id, cue.number, cue.name, cue.content, cue.warning,
            cue.start_kind, cue.start_snapshot_id, cue.start_offset,
            cue.end_kind,   cue.end_snapshot_id,   cue.end_offset
     FROM cue
     WHERE (start_snapshot_id = $1 OR end_snapshot_id = $1)
       AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = cue.id AND cv.version_id = $2)`,
    [deletedSnapshotId, versionId]
  );
  if (!affected.rows.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const cur of affected.rows) {
      const startHit = cur.start_snapshot_id === deletedSnapshotId;
      const endHit   = cur.end_snapshot_id   === deletedSnapshotId;

      if (!prevSnapshotId && !nextSnapshotId) {
        // Deleted block was the only one — remove the cue from this version
        await removeCueFromVersion(client, versionId, cur.id);
        continue;
      }

      const patch: Parameters<typeof cowCue>[3] = { warning: true };
      if (startHit) {
        if (prevSnapshotId) { patch.start_kind = "gap";   patch.start_snapshot_id = prevSnapshotId; patch.start_offset = null; }
        else                { patch.start_kind = "block"; patch.start_snapshot_id = nextSnapshotId!; patch.start_offset = 0; }
      }
      if (endHit) {
        if (prevSnapshotId) { patch.end_kind = "gap";   patch.end_snapshot_id = prevSnapshotId; patch.end_offset = null; }
        else                { patch.end_kind = "block"; patch.end_snapshot_id = nextSnapshotId!; patch.end_offset = 0; }
      }
      await applyPatchWithCow(client, versionId, cur, patch);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Called when a snapshot's text content changes (and optionally gets a new snapshot id via CoW).
 * Adjusts cue offsets that reference oldSnapshotId, re-pointing to newSnapshotId.
 * Performs CoW on shared cue revisions.
 */
export async function handleBlockContentChanged(
  oldSnapshotId: string,
  newSnapshotId: string,  // equals oldSnapshotId when no block CoW occurred
  oldContent: string,
  newContent: string,
  versionId: string,
): Promise<void> {
  if (oldContent === newContent) return;

  const res = await getPool().query<CueFullRow>(
    `SELECT cue.id, cue.cue_id, cue.cue_list_id, cue.number, cue.name, cue.content, cue.warning,
            cue.start_kind, cue.start_snapshot_id, cue.start_offset,
            cue.end_kind,   cue.end_snapshot_id,   cue.end_offset
     FROM cue
     WHERE ((start_kind='block' AND start_snapshot_id=$1)
        OR  (end_kind='block'   AND end_snapshot_id=$1))
       AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = cue.id AND cv.version_id = $2)`,
    [oldSnapshotId, versionId]
  );
  if (!res.rows.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of res.rows) {
      const startInBlock = row.start_kind === "block" && row.start_snapshot_id === oldSnapshotId;
      const endInBlock   = row.end_kind   === "block" && row.end_snapshot_id   === oldSnapshotId;

      let newStartOffset = row.start_offset;
      let newEndOffset   = row.end_offset;
      let warn = row.warning;

      if (startInBlock && endInBlock) {
        const result = adjustBlockAnchor(oldContent, newContent, row.start_offset!, row.end_offset!);
        newStartOffset = result.startOffset;
        newEndOffset   = result.endOffset;
      } else {
        if (startInBlock) newStartOffset = lcsAdjust(oldContent, newContent, row.start_offset!);
        if (endInBlock)   newEndOffset   = lcsAdjust(oldContent, newContent, row.end_offset!);
      }
      warn = true; // any automatic position adjustment warrants review

      const snapshotChanged = oldSnapshotId !== newSnapshotId;
      const offsetChanged   = newStartOffset !== row.start_offset || newEndOffset !== row.end_offset;
      const warnChanged     = warn !== row.warning;
      if (!snapshotChanged && !offsetChanged && !warnChanged) continue;

      const patch: Parameters<typeof cowCue>[3] = { warning: warn };
      if (startInBlock) {
        patch.start_snapshot_id = newSnapshotId;
        patch.start_offset = newStartOffset ?? undefined;
      }
      if (endInBlock) {
        patch.end_snapshot_id = newSnapshotId;
        patch.end_offset = newEndOffset ?? undefined;
      }

      await applyPatchWithCow(client, versionId, row, patch);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

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

// ─── Asset mount CoW helpers ──────────────────────────────────────────────────

/**
 * Copy-on-write a block snapshot for an asset mount operation.
 * 快照被遗留多版本共享时，为当前版本分裂出独立快照（保护历史版本只读）。
 * Returns the snapshot ID the mount should be created against.
 */
export async function cowBlockSnapshotForMount(
  versionId: string,
  snapshotId: string,
): Promise<string> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const refRes = await client.query<{ cnt: string }>(
      'SELECT COUNT(*) AS cnt FROM script_version WHERE version_id = $1 AND snapshot_id = $2',
      [versionId, snapshotId]
    );
    if (parseInt(refRes.rows[0].cnt, 10) !== 1) {
      throw new Error("Block snapshot does not belong to version");
    }

    const allRefRes = await client.query<{ cnt: string }>(
      'SELECT COUNT(*) AS cnt FROM script_version WHERE snapshot_id = $1',
      [snapshotId]
    );
    if (parseInt(allRefRes.rows[0].cnt, 10) <= 1) {
      await client.query('COMMIT');
      return snapshotId;
    }

    const newSnapshotId = genSnapshotId();

    await client.query(
      `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
       SELECT $1, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name
       FROM script WHERE id = $2`,
      [newSnapshotId, snapshotId]
    );
    await client.query(
      `INSERT INTO script_character (script_id, character_id, position, annotation)
       SELECT $1, character_id, position, annotation FROM script_character WHERE script_id = $2`,
      [newSnapshotId, snapshotId]
    );
    // block_tag rows are keyed by logical block_id, not snapshot_id — no copy needed.

    await client.query(
      'UPDATE script_version SET snapshot_id = $1 WHERE snapshot_id = $2 AND version_id = $3',
      [newSnapshotId, snapshotId, versionId]
    );

    // Carry existing asset_mount entries to the new snapshot
    await client.query(
      `INSERT INTO asset_mount
         (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
          folder_path, mount_mode, version_resolved, created_by)
       SELECT 'am_' || substr(md5(id || $1), 1, 16),
         asset_id, production_id, 'block_snapshot', $1, mount_aux_id,
         folder_path, mount_mode, version_resolved, created_by
       FROM asset_mount WHERE mount_type = 'block_snapshot' AND mount_id = $2`,
      [newSnapshotId, snapshotId]
    );

    await client.query('COMMIT');
    return newSnapshotId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Copy-on-write a cue revision for an asset mount operation.
 * 修订被遗留多版本共享时，为当前版本分裂出独立修订（保护历史版本只读）。
 * Returns the revision ID the mount should be created against.
 */
export async function cowCueRevisionForMount(
  versionId: string,
  revisionId: string,
): Promise<string> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const refRes = await client.query<{ cnt: string }>(
      'SELECT COUNT(*) AS cnt FROM cue_version WHERE version_id = $1 AND revision_id = $2',
      [versionId, revisionId]
    );
    if (parseInt(refRes.rows[0].cnt, 10) !== 1) {
      throw new Error("Cue revision does not belong to version");
    }

    const allRefRes = await client.query<{ cnt: string }>(
      'SELECT COUNT(*) AS cnt FROM cue_version WHERE revision_id = $1',
      [revisionId]
    );
    if (parseInt(allRefRes.rows[0].cnt, 10) <= 1) {
      await client.query('COMMIT');
      return revisionId;
    }

    const curRes = await client.query<CueFullRow>(
      `SELECT id, cue_id, cue_list_id, number, name, content, warning,
         start_kind, start_snapshot_id, start_offset,
         end_kind,   end_snapshot_id,   end_offset
       FROM cue WHERE id = $1`,
      [revisionId]
    );
    const cur = curRes.rows[0];
    if (!cur) { await client.query('COMMIT'); return revisionId; }

    const newId = newCueId();

    await client.query(
      `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
         start_kind, start_snapshot_id, start_offset,
         end_kind,   end_snapshot_id,   end_offset, warning)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [newId, cur.cue_id ?? cur.id, cur.cue_list_id,
       cur.number, cur.name, cur.content,
       cur.start_kind, cur.start_snapshot_id, cur.start_offset,
       cur.end_kind, cur.end_snapshot_id, cur.end_offset, cur.warning]
    );

    await client.query(
      'UPDATE cue_version SET revision_id = $1 WHERE revision_id = $2 AND version_id = $3',
      [newId, revisionId, versionId]
    );

    // Carry existing asset_mount entries to the new revision
    await client.query(
      `INSERT INTO asset_mount
         (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
          folder_path, mount_mode, version_resolved, created_by)
       SELECT 'am_' || substr(md5(id || $1), 1, 16),
         asset_id, production_id, 'cue_revision', $1, mount_aux_id,
         folder_path, mount_mode, version_resolved, created_by
       FROM asset_mount WHERE mount_type = 'cue_revision' AND mount_id = $2`,
      [newId, revisionId]
    );

    await client.query('COMMIT');
    return newId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** All productions where the user has a membership role (regardless of SA status). */
export async function listMemberProductions(userId: string): Promise<{ id: string; name: string; archivedAt: string | null; roles: string[] }[]> {
  const res = await getPool().query<{ id: string; name: string; archived_at: Date | null; roles: string[] }>(
    `SELECT p.id, p.name, p.archived_at, pm.roles
     FROM production p
     JOIN production_member pm ON pm.production_id = p.id
     WHERE pm.user_id = $1
     ORDER BY CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END, p.sort_order ASC, p.created_at ASC`,
    [userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    archivedAt: r.archived_at?.toISOString() ?? null,
    roles: r.roles,
  }));
}

// ─── Atomic patch application ─────────────────────────────────────────────────

const ALL_PATCH_LAYOUTS: PageLayout[] = ["a4", "letter", "a3-2col", "tablet-2col"];
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
  state: ScriptState,
  dirty: "full" | Array<{ start: number; end: number }>,
): Promise<void> {
  let changed = false;
  const computed = ALL_PATCH_LAYOUTS.map((layout) => {
    const key = `${productionId}:${versionId}:${layout}`;
    const previous = pageMapCache.get(key) ?? null;
    const cache = updateEstimatedPageMap(
      previous,
      state.blocks,
      layout,
      state.config.textLayoutMode,
      false,
      previous ? dirty : "full",
    );
    if (cache !== previous) changed = true;
    return { key, layout, cache };
  });
  if (!changed) return;
  await writePageMap(productionId, Object.fromEntries(
    computed.map(({ layout, cache }) => [layout, cache.pageMap]),
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
      const result = await loadProduction(productionId, versionId);
      if (result) await saveEstimatedPageMaps(productionId, versionId, result.state, dirty);
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
            await client.query(
              `INSERT INTO asset_mount
                 (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
                  folder_path, mount_mode, version_resolved, created_by)
               SELECT 'am_' || substr(md5(id || $1), 1, 16),
                 asset_id, production_id, 'block_snapshot', $1, mount_aux_id,
                 folder_path, mount_mode, version_resolved, created_by
               FROM asset_mount WHERE mount_type = 'block_snapshot' AND mount_id = $2`,
              [newSnapshotId, oldSnapshotId]
            );
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
          // Clean up asset_mount for the GC'd block_snapshot if it was actually deleted
          await client.query(
            `DELETE FROM asset_mount
             WHERE mount_type = 'block_snapshot' AND mount_id = $1
               AND NOT EXISTS (SELECT 1 FROM script WHERE id = $1)`,
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

// ── Milestones ────────────────────────────────────────────────────────────────

export type Milestone = {
  id: string;
  productionId: string;
  name: string;
  endDate: string;
  sortOrder: number;
  createdAt: string;
};

type MilestoneRow = {
  id: string;
  production_id: string;
  name: string;
  end_date: string;
  sort_order: number;
  created_at: Date;
};

function mapMilestoneRow(r: MilestoneRow): Milestone {
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    endDate: r.end_date,
    sortOrder: r.sort_order,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listMilestones(productionId: string): Promise<Milestone[]> {
  const res = await getPool().query<MilestoneRow>(
    "SELECT id, production_id, name, end_date::text AS end_date, sort_order, created_at FROM milestone WHERE production_id = $1 ORDER BY end_date ASC, sort_order ASC",
    [productionId],
  );
  return res.rows.map(mapMilestoneRow);
}

export async function createMilestone(
  id: string,
  productionId: string,
  name: string,
  endDate: string,
  sortOrder: number,
): Promise<Milestone> {
  const res = await getPool().query<MilestoneRow>(
    `INSERT INTO milestone (id, production_id, name, end_date, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, production_id, name, end_date::text AS end_date, sort_order, created_at`,
    [id, productionId, name, endDate, sortOrder],
  );
  return mapMilestoneRow(res.rows[0]);
}

export async function updateMilestone(
  id: string,
  fields: { name?: string; endDate?: string; sortOrder?: number },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) { sets.push(`name = $${vals.push(fields.name)}`); }
  if (fields.endDate !== undefined) { sets.push(`end_date = $${vals.push(fields.endDate)}`); }
  if (fields.sortOrder !== undefined) { sets.push(`sort_order = $${vals.push(fields.sortOrder)}`); }
  if (!sets.length) return;
  vals.push(id);
  await getPool().query(`UPDATE milestone SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

export async function deleteMilestone(id: string): Promise<void> {
  await getPool().query("DELETE FROM milestone WHERE id = $1", [id]);
}

export async function getMilestone(id: string): Promise<Milestone | null> {
  const res = await getPool().query<MilestoneRow>(
    "SELECT id, production_id, name, end_date::text AS end_date, sort_order, created_at FROM milestone WHERE id = $1",
    [id],
  );
  return res.rows[0] ? mapMilestoneRow(res.rows[0]) : null;
}

// ── Announcements ─────────────────────────────────────────────────────────────

export type ProductionAnnouncement = {
  id: string;
  productionId: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type AnnouncementRow = {
  id: string;
  production_id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

function mapAnnouncementRow(r: AnnouncementRow): ProductionAnnouncement {
  return {
    id: r.id,
    productionId: r.production_id,
    title: r.title,
    content: r.content,
    isPinned: r.is_pinned,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listAnnouncements(productionId: string): Promise<ProductionAnnouncement[]> {
  const res = await getPool().query<AnnouncementRow>(
    `SELECT id, production_id, title, content, is_pinned, created_by, created_at, updated_at
     FROM production_announcement WHERE production_id = $1 ORDER BY created_at DESC`,
    [productionId],
  );
  return res.rows.map(mapAnnouncementRow);
}

export async function createAnnouncement(
  id: string,
  productionId: string,
  title: string,
  content: string,
  createdBy: string,
): Promise<ProductionAnnouncement> {
  const res = await getPool().query<AnnouncementRow>(
    `INSERT INTO production_announcement (id, production_id, title, content, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, production_id, title, content, is_pinned, created_by, created_at, updated_at`,
    [id, productionId, title, content, createdBy],
  );
  return mapAnnouncementRow(res.rows[0]);
}

export async function getAnnouncement(id: string): Promise<ProductionAnnouncement | null> {
  const res = await getPool().query<AnnouncementRow>(
    `SELECT id, production_id, title, content, is_pinned, created_by, created_at, updated_at
     FROM production_announcement WHERE id = $1`,
    [id],
  );
  return res.rows[0] ? mapAnnouncementRow(res.rows[0]) : null;
}

export async function updateAnnouncement(
  id: string,
  productionId: string,
  fields: { title?: string; content?: string; isPinned?: boolean },
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (fields.isPinned === true) {
      await client.query(
        "UPDATE production_announcement SET is_pinned = false WHERE production_id = $1 AND is_pinned = true AND id != $2",
        [productionId, id],
      );
    }
    const sets: string[] = ["updated_at = now()"];
    const vals: unknown[] = [];
    if (fields.title !== undefined) { sets.push(`title = $${vals.push(fields.title)}`); }
    if (fields.content !== undefined) { sets.push(`content = $${vals.push(fields.content)}`); }
    if (fields.isPinned !== undefined) { sets.push(`is_pinned = $${vals.push(fields.isPinned)}`); }
    vals.push(id);
    await client.query(
      `UPDATE production_announcement SET ${sets.join(", ")} WHERE id = $${vals.length}`,
      vals,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await getPool().query("DELETE FROM production_announcement WHERE id = $1", [id]);
}

// ── Cross-project queries ─────────────────────────────────────────────────────

export type CrossProjectAnnouncement = {
  id: string;
  productionId: string;
  productionName: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
};

export async function listAnnouncementsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<CrossProjectAnnouncement[]> {
  const res = await getPool().query<{
    id: string; production_id: string; production_name: string;
    title: string; content: string; is_pinned: boolean; created_at: Date;
  }>(
    `SELECT pa.id, pa.production_id, p.name AS production_name,
            pa.title, pa.content, pa.is_pinned, pa.created_at
     FROM production_announcement pa
     JOIN production p ON pa.production_id = p.id
     WHERE p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = pa.production_id AND pm.user_id = $2
           AND pm.status = 'active'
       ))
     ORDER BY pa.is_pinned DESC, pa.created_at DESC
     LIMIT 50`,
    [isAdmin, userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    productionId: r.production_id,
    productionName: r.production_name,
    title: r.title,
    content: r.content,
    isPinned: r.is_pinned,
    createdAt: r.created_at.toISOString(),
  }));
}

// ── Announcement read tracking ────────────────────────────────────────────────

export async function markAnnouncementRead(announcementId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO announcement_read (announcement_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
    [announcementId, userId],
  );
}

export type AnnouncementReadMember = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  readAt: string | null;
};

export async function getAnnouncementReadStatus(
  announcementId: string,
  productionId: string,
): Promise<AnnouncementReadMember[]> {
  const res = await getPool().query<{
    user_id: string;
    name: string;
    avatar_url: string | null;
    read_at: Date | null;
  }>(
    `SELECT pm.user_id, COALESCE(up.name, '') AS name, up.avatar_url, ar.read_at
     FROM production_member pm
     LEFT JOIN user_profile up ON up.user_id = pm.user_id
     LEFT JOIN announcement_read ar
       ON ar.announcement_id = $1 AND ar.user_id = pm.user_id
     WHERE pm.production_id = $2 AND pm.status = 'active'
     ORDER BY ar.read_at NULLS LAST, up.name NULLS LAST`,
    [announcementId, productionId],
  );
  return res.rows.map(r => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    readAt: r.read_at ? r.read_at.toISOString() : null,
  }));
}

export async function getUserAllReadAnnouncementIds(userId: string): Promise<string[]> {
  const res = await getPool().query<{ announcement_id: string }>(
    `SELECT announcement_id FROM announcement_read WHERE user_id = $1`,
    [userId],
  );
  return res.rows.map(r => r.announcement_id);
}

export async function getUserAnnouncementReadIds(
  productionId: string,
  userId: string,
): Promise<string[]> {
  const res = await getPool().query<{ announcement_id: string }>(
    `SELECT ar.announcement_id
     FROM announcement_read ar
     JOIN production_announcement pa ON pa.id = ar.announcement_id
     WHERE pa.production_id = $1 AND ar.user_id = $2`,
    [productionId, userId],
  );
  return res.rows.map(r => r.announcement_id);
}

export async function getUnreadMemberIds(
  announcementId: string,
  productionId: string,
): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT pm.user_id
     FROM production_member pm
     WHERE pm.production_id = $1 AND pm.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM announcement_read ar
         WHERE ar.announcement_id = $2 AND ar.user_id = pm.user_id
       )`,
    [productionId, announcementId],
  );
  return res.rows.map(r => r.user_id);
}

export type CueWarningEntry = {
  id: string;
  cueListId: string;
  cueListAbbr: string;
  number: string;
  name: string;
  productionId: string;
  productionName: string;
  startKind: "block" | "gap";
  endKind: "block" | "gap";
  warningType: "orphaned" | "adjusted";
};

export async function listCueWarningsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<CueWarningEntry[]> {
  const res = await getPool().query<{
    id: string; cue_list_id: string; cue_list_abbr: string;
    number: string; name: string; production_id: string; production_name: string;
    start_kind: string; end_kind: string;
  }>(
    `SELECT c.id, c.cue_list_id, cl.abbr AS cue_list_abbr,
            c.number, c.name, cl.production_id, p.name AS production_name,
            c.start_kind, c.end_kind
     FROM cue c
     JOIN cue_list cl ON c.cue_list_id = cl.id
     JOIN production p ON cl.production_id = p.id
     WHERE c.warning = TRUE
       AND p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = cl.production_id AND pm.user_id = $2
           AND pm.status = 'active'
       ))
     ORDER BY p.name, cl.abbr, c.number`,
    [isAdmin, userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    cueListId: r.cue_list_id,
    cueListAbbr: r.cue_list_abbr,
    number: r.number,
    name: r.name,
    productionId: r.production_id,
    productionName: r.production_name,
    startKind: r.start_kind as "block" | "gap",
    endKind: r.end_kind as "block" | "gap",
    warningType: (r.start_kind === "gap" || r.end_kind === "gap") ? "orphaned" : "adjusted",
  }));
}

export type UpcomingMilestoneEntry = {
  id: string;
  name: string;
  endDate: string;
  productionId: string;
  productionName: string;
};

export async function listUpcomingMilestonesForUser(
  userId: string,
  isAdmin: boolean,
): Promise<UpcomingMilestoneEntry[]> {
  const res = await getPool().query<{
    id: string; name: string; end_date: string;
    production_id: string; production_name: string;
  }>(
    `SELECT m.id, m.name, m.end_date::text AS end_date,
            m.production_id, p.name AS production_name
     FROM milestone m
     JOIN production p ON m.production_id = p.id
     WHERE m.end_date >= CURRENT_DATE
       AND p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = m.production_id AND pm.user_id = $2
       ))
     ORDER BY m.end_date ASC, m.sort_order ASC
     LIMIT 10`,
    [isAdmin, userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    endDate: r.end_date,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}

export async function countCueWarningsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<number> {
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue c
     JOIN cue_list cl ON c.cue_list_id = cl.id
     JOIN production p ON cl.production_id = p.id
     WHERE c.warning = TRUE
       AND p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = cl.production_id AND pm.user_id = $2
           AND pm.status = 'active'
       ))`,
    [isAdmin, userId],
  );
  return parseInt(res.rows[0].count, 10);
}

// ─── Phase 7: Approval Flow ───────────────────────────────────────────────────

export type ApprovalRequest = {
  id: string;
  productionId: string;
  subjectId: string;
  subjectName?: string;
  type: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceSub: string | null;
  permissionLevel: string | null;
  grantType: "permanent" | "ttl" | null;
  /**
   * 展示用中文串（"7天"），仅供渲染。**不是**提交侧的线格式——
   * SubmitAccessRequestParams.ttlDuration 要的是 Postgres INTERVAL 字面量
   * （"7 days"），两者不可互相回灌。要算剩余时长请用 expiresAt。
   */
  ttlDurationLabel: string | null;
  /** 自定义有效期在提交时选定的绝对到期时间；固定档位为 null。 */
  requestedExpiresAt: string | null;
  note: string | null;
  status: "pending_supervisor" | "pending_resource" | "approved" | "rejected" | "cancelled";
  escalationChain: ApprovalChainEntry[];
  /** 当前审批阶梯级（#140）；已 resolve 的申请为 null。 */
  currentStage: ApprovalStageName | null;
  currentApproverIds: string[];
  /**
   * 当前查看者能否直接批准。false = 只能向上转发（直属上级本人没有这个权限）。
   * 由 listPendingApprovals 按级填充，其余读取路径为 null（不适用）。
   */
  canFinalize: boolean | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  /**
   * 这条申请里出现过的所有人（申请人、各级审批人候选、操作人、终结者）→ 姓名与角色。
   * 由 attachApprovalPeople 填充；未经该函数的读取路径为空对象，消费方按 ID 降级。
   */
  people: Record<string, ApprovalPerson>;
};

export type ApprovalChainEntry = {
  /** 旧两段式字段，保留给存量行与既有 UI；新写入按 stage 派生。 */
  phase: "supervisor" | "resource";
  /** #140 阶梯级名与层深（存量行无此字段）。 */
  stage?: ApprovalStageName;
  depth?: number;
  canFinalize?: boolean;
  approverIds: string[];
  notifiedAt: string;
  /** cancelled = 这一级还没处理，申请就被申请人撤回或被新申请顶掉了。 */
  action?: ApprovalAction;
  /**
   * 动作的操作人。**系统动作没有这个字段**（见 bySystem）——
   * 消费方不能把「有没有 actorId」当成「有没有发生过动作」来判。
   */
  actorId?: string;
  actedAt?: string;
  /**
   * 该动作由系统发起，没有操作人：超时自动升级、被新申请顶掉的旧申请。
   * 这个字段是补给前端的：此前超时升级只留下 escalationReason='timeout'
   * 而没有 actorId，UI 把「原因」挂在「操作人」下面渲染，于是最该说清楚的
   * 「没人处理，超时自动升上去了」反而一个字都显示不出来。
   */
  bySystem?: boolean;
  /** escalated 的原因：超时自动升级 / 审批人手动转发。 */
  escalationReason?: "timeout" | "forwarded";
  /** cancelled 的原因：申请人主动撤回 / 被同目标的新申请覆盖。 */
  cancelReason?: "by_subject" | "superseded" | "expired";
  /**
   * 审批意见：批准/拒绝/转交/撤回时写下的理由，随动作落在这一级上。
   *
   * 落在链条目而不是单开评论表：这是**审批决定的一部分**，跟着决定走、
   * 跟着决定不可变。真要做多人讨论区是另一回事（要作者、可见范围、附件），
   * 那时再单开表，不影响这里。
   */
  comment?: string;
};

/**
 * 审批链上出现过的人。**由读取路径按当前 user_profile 现算**，不是落库快照——
 * 姓名快照的收益（离职改名后历史不失真）撑不起每次升级多查一次名字的成本
 * （2026-08-25 用户定谳）。
 *
 * 有它之后前端不必再联查 /contacts 反查姓名：那条路既拉了全员邮箱手机号，
 * 又覆盖不到不在 production_member 里的审批人。
 */
export type ApprovalPerson = {
  userId: string;
  name: string;
  /** 该人在本演出的角色（不在本演出时为空数组）。 */
  roles: string[];
  /** false = 此人已不在（或从未在）本演出的成员名单里，但仍是链上的真实审批人。 */
  isMember: boolean;
};

type ApprovalRow = {
  id: string;
  production_id: string;
  subject_id: string;
  subject_name?: string | null;
  type: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_sub: string | null;
  permission_level: string | null;
  grant_type: string | null;
  ttl_duration: PgInterval | string | null;
  requested_expires_at: Date | null;
  note: string | null;
  status: string;
  escalation_chain: ApprovalChainEntry[];
  current_stage: string | null;
  current_stage_depth: number | null;
  current_approver_ids: string[] | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  granted_at: Date | null;
  expires_at: Date | null;
};

/**
 * node-postgres 把 INTERVAL 列解析成 postgres-interval 对象（如 '7 days' → { days: 7 }），
 * 不是字符串。裸传给前端会触发 "Objects are not valid as a React child"。
 */
export type PgInterval = {
  years?: number; months?: number; days?: number;
  hours?: number; minutes?: number; seconds?: number; milliseconds?: number;
};

// 必须覆盖 PgInterval 的每个字段：漏一个就是静默丢数据。
// 例：'1.5 seconds'::interval → { seconds: 1, milliseconds: 500 }，
// 漏掉 milliseconds 会渲染成 "1秒"；'500 ms' 更会整条塌成 null。
const INTERVAL_UNITS: [keyof PgInterval, string][] = [
  ["years", "年"], ["months", "个月"], ["days", "天"],
  ["hours", "小时"], ["minutes", "分钟"], ["seconds", "秒"], ["milliseconds", "毫秒"],
];

export function formatPgInterval(v: PgInterval | string | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;  // 兼容 type parser 被改回字符串的情况
  const parts = INTERVAL_UNITS
    .filter(([k]) => typeof v[k] === "number" && v[k] !== 0)
    .map(([k, label]) => `${v[k]}${label}`);
  return parts.join("") || null;
}

function rowToApproval(r: ApprovalRow): ApprovalRequest {
  return {
    id: r.id,
    productionId: r.production_id,
    subjectId: r.subject_id,
    subjectName: r.subject_name ?? undefined,
    type: r.type,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    resourceSub: r.resource_sub,
    permissionLevel: r.permission_level,
    grantType: (r.grant_type as "permanent" | "ttl" | null),
    ttlDurationLabel: formatPgInterval(r.ttl_duration),
    requestedExpiresAt: r.requested_expires_at ? r.requested_expires_at.toISOString() : null,
    note: r.note,
    status: r.status as ApprovalRequest["status"],
    escalationChain: r.escalation_chain ?? [],
    currentStage: (r.current_stage as ApprovalStageName | null) ?? null,
    currentApproverIds: r.current_approver_ids ?? [],
    canFinalize: null,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    resolvedBy: r.resolved_by,
    grantedAt: r.granted_at ? r.granted_at.toISOString() : null,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    people: {},
  };
}

/** 一条申请里出现过的全部用户 ID：申请人、各级候选审批人、操作人、终结者。 */
function collectApprovalUserIds(req: ApprovalRequest): string[] {
  const ids = new Set<string>([req.subjectId]);
  if (req.resolvedBy) ids.add(req.resolvedBy);
  req.currentApproverIds.forEach((id) => ids.add(id));
  for (const entry of req.escalationChain) {
    (entry.approverIds ?? []).forEach((id) => ids.add(id));
    if (entry.actorId) ids.add(entry.actorId);
  }
  return [...ids];
}

/**
 * 批量解析用户 ID → 姓名/角色。一次查完整批申请，不按条 N+1。
 *
 * 姓名口径与通知、财务、部门冻结一致：display_name 优先、退回 name。
 * **不 join feishu_user**（#234 身份债已清偿：显示名只走 user_profile）。
 * 查无此人（profile 行缺失）不返回条目，消费方按 ID 降级显示。
 */
async function loadApprovalPeople(
  productionId: string,
  userIds: string[],
): Promise<Record<string, ApprovalPerson>> {
  if (userIds.length === 0) return {};
  const { rows } = await getPool().query<{
    user_id: string; name: string | null; roles: string[] | null; is_member: boolean;
  }>(
    `SELECT up.user_id,
            COALESCE(NULLIF(up.display_name, ''), NULLIF(up.name, '')) AS name,
            pm.roles,
            (pm.user_id IS NOT NULL) AS is_member
     FROM user_profile up
     LEFT JOIN production_member pm
       ON pm.production_id = $2 AND pm.user_id = up.user_id
     WHERE up.user_id = ANY($1::uuid[])`,
    [userIds, productionId],
  );
  const out: Record<string, ApprovalPerson> = {};
  for (const r of rows) {
    if (!r.name) continue;  // 无名可显示时不如让消费方走自己的降级文案
    out[r.user_id] = {
      userId: r.user_id,
      name: r.name,
      roles: r.roles ?? [],
      isMember: r.is_member,
    };
  }
  return out;
}

/**
 * 给一批申请填 people。审批链上的人**不一定是 production_member**
 * （祖先部门 POC、存量演出的 owner 都可能不在名单里），所以这里按 user_profile
 * 取名、按 production_member 取角色，两者分开——用成员表 INNER JOIN 取名会让
 * 这些人整个消失（feedback_fixture_hides_prod 的同款坑）。
 */
async function attachApprovalPeople(requests: ApprovalRequest[]): Promise<ApprovalRequest[]> {
  if (requests.length === 0) return requests;
  // 同一次调用里所有申请都属同一个演出（列表接口按演出过滤），按演出分组兜底跨演出调用
  const byProduction = new Map<string, ApprovalRequest[]>();
  for (const req of requests) {
    const bucket = byProduction.get(req.productionId);
    if (bucket) bucket.push(req);
    else byProduction.set(req.productionId, [req]);
  }
  for (const [productionId, group] of byProduction) {
    const ids = [...new Set(group.flatMap(collectApprovalUserIds))];
    const people = await loadApprovalPeople(productionId, ids);
    for (const req of group) {
      req.people = Object.fromEntries(
        collectApprovalUserIds(req)
          .map((id) => [id, people[id]] as const)
          .filter((pair): pair is readonly [string, ApprovalPerson] => pair[1] !== undefined),
      );
    }
  }
  return requests;
}

/** 单条申请的 people 填充——动作接口回给前端的那条也要带人，否则页面刷新前是空的。 */
async function withApprovalPeople(request: ApprovalRequest): Promise<ApprovalRequest> {
  const [filled] = await attachApprovalPeople([request]);
  return filled;
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  cue_list: "Cue表",
  scene:    "章节/段落",
  event:    "事件",
};

const PERMISSION_LEVEL_LABELS: Record<string, string> = {
  view:           "查看",
  mount:          "挂载",
  edit:           "编辑",
  manage:         "管理",
  publish:        "发布",
  edit_published: "修改已发布",
  revoke:         "撤销",
};

/**
 * Returns a human-readable description of a resource for use in notification text.
 * e.g. "「声响」Cue表的编辑权限"
 */
async function describeResource(
  resourceType: string,
  resourceId: string,
  permissionLevel: string,
): Promise<string> {
  const typeLabel  = RESOURCE_TYPE_LABELS[resourceType] ?? resourceType;
  const levelLabel = PERMISSION_LEVEL_LABELS[permissionLevel] ?? permissionLevel;

  // Fetch the specific resource name when a concrete ID is given
  let resourceName: string | null = null;
  if (resourceId !== "*") {
    if (resourceType === "cue_list") {
      const r = await getPool().query<{ name: string }>(
        `SELECT name FROM cue_list WHERE id = $1`,
        [resourceId],
      );
      resourceName = r.rows[0]?.name ?? null;
    } else if (resourceType === "scene") {
      // scene 已是纯身份锚点（marker 化后只剩 id/production_id），名字在
      // scene_version（由 marker 派生）。旧写法查 scene.name/number 必抛 42703。
      const r = await getPool().query<{ name: string }>(
        `SELECT COALESCE(NULLIF(sv.name, ''), '未命名') AS name
         FROM scene s
         JOIN production p ON p.id = s.production_id
         JOIN scene_version sv ON sv.scene_id = s.id AND sv.version_id = p.active_version_id
         WHERE s.id = $1`,
        [resourceId],
      );
      resourceName = r.rows[0]?.name ?? null;
    } else if (resourceType === "event") {
      const r = await getPool().query<{ name: string }>(
        `SELECT COALESCE(name, '') AS name FROM production_event WHERE id = $1`,
        [resourceId],
      );
      resourceName = r.rows[0]?.name || null;
    }
  }

  // 名字解析不出来 ≠ 申请的是全部资源：具体 id 解析失败（资源已删、或跨演出
  // 不可见）时说「所有X」是把申请范围说大了，审批人据此判断就是错的。
  const resourceDesc = resourceName
    ? `「${resourceName}」${typeLabel}`
    : resourceId !== "*" ? `某个${typeLabel}` : `所有${typeLabel}`;
  return `${resourceDesc}的${levelLabel}权限`;
}

// ─── 审批路由接入（#140）──────────────────────────────────────────────────────
// 「谁来批」全部由 lib/approval-routing.ts 的阶梯算出，此处只负责落库、通知、状态机。
// 收件箱（listPendingApprovals）与鉴权（authorizeApprovalAction）只读
// current_approver_ids，不再各自重算路由——三处漂移的老账在此了结。

export class ApprovalRequestError extends Error {
  constructor(public reason: "no_entry" | "invalid_ttl" | "no_approver") {
    super(reason);
    this.name = "ApprovalRequestError";
  }
}

function approvalTargetOf(req: ApprovalRow): ApprovalTarget {
  return {
    productionId:    req.production_id,
    subjectId:       req.subject_id,
    resourceType:    req.resource_type ?? "",
    resourceId:      req.resource_id ?? "*",
    resourceSub:     req.resource_sub ?? "*",
    permissionLevel: req.permission_level ?? "",
  };
}

function currentPositionOf(req: ApprovalRow): StagePosition | null {
  return req.current_stage
    ? { stage: req.current_stage as ApprovalStageName, depth: req.current_stage_depth ?? 0 }
    : null;
}

function isPendingStatus(status: string): boolean {
  return status === "pending_supervisor" || status === "pending_resource";
}

function chainEntryFor(stage: ApprovalStage): ApprovalChainEntry {
  return {
    phase: stage.stage === "supervisor" ? "supervisor" : "resource",
    stage: stage.stage,
    depth: stage.depth,
    canFinalize: stage.canFinalize,
    approverIds: stage.approverIds,
    notifiedAt: new Date().toISOString(),
  };
}

async function loadApproval(requestId: string): Promise<ApprovalRow | null> {
  const { rows } = await getPool().query<ApprovalRow>(
    `SELECT * FROM approval_request WHERE id = $1`,
    [requestId],
  );
  return rows[0] ?? null;
}

/**
 * 给 escalation_chain 末条补字段（批准/拒绝/转发的落点）。
 * 单条 SQL 完成读改写——旧代码是「读出整条链 → JS 改 → 整条写回」，
 * 期间若有别的升级追加了条目就会被覆盖掉。
 */
async function markLastChainEntry(requestId: string, patch: Partial<ApprovalChainEntry>): Promise<void> {
  await getPool().query(
    `UPDATE approval_request
     SET escalation_chain = jsonb_set(
           escalation_chain,
           ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
           (escalation_chain -> -1) || $2::jsonb)
     WHERE id = $1 AND jsonb_array_length(escalation_chain) > 0`,
    [requestId, JSON.stringify(patch)],
  );
}

async function expireRequestNotifications(requestId: string): Promise<void> {
  await getPool().query(
    `UPDATE user_notification SET expired_at = now()
     WHERE approval_request_id = $1 AND expired_at IS NULL AND acted_at IS NULL`,
    [requestId],
  );
}

/**
 * 自定义有效期的申请，在「提交 → 批准」的等待期里被跨过到期日 = 这条申请已经
 * 没有可发放的东西了。自定义档位存的是**绝对时间**（不像固定档位从批准时起算），
 * 所以审批拖过所选日期是常态，不是边角。
 *
 * 不处理的话它会落到 approve 的 first-action-wins 0 行分支，回一句「已被他人
 * 处理」的假错误，而申请永远停在 pending —— 审批人点多少次都是同一条谎，待办
 * 永远挂在收件箱里。按「被新申请取代」的同一套处理：自动 cancel、过期待办、
 * 链上记明原因，并告诉申请人这条已经作废、需要重提。
 *
 * 返回 true 表示这次调用确实把它终结了（或它已被并发的另一路终结）。
 */
async function cancelIfCustomExpiryPassed(req: ApprovalRow): Promise<boolean> {
  if (!req.requested_expires_at || req.requested_expires_at.getTime() > Date.now()) return false;

  // 到期判定以 DB 的 now() 为准，别用上面那次 JS 比较的结果去写库：
  // JS 侧只是为了不给绝大多数请求平白加一次 UPDATE。
  const res = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'cancelled', resolved_at = now(),
         current_stage = NULL, current_approver_ids = '{}'
     WHERE id = $1
       AND status IN ('pending_supervisor', 'pending_resource')
       AND requested_expires_at IS NOT NULL
       AND requested_expires_at <= now()
     RETURNING id`,
    [req.id],
  );
  if (!res.rows[0]) return false;

  // resolved_by 留 NULL：没有人处理这条申请，是它自己作废的。时间线据此把终结
  // 节点画成「系统自动处理」而不是安一个并没做事的操作人。
  await markLastChainEntry(req.id, {
    action: "cancelled", actedAt: new Date().toISOString(),
    bySystem: true, cancelReason: "expired",
  });
  await expireRequestNotifications(req.id);

  const desc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  await notifyUser({
    userId: req.subject_id,
    productionId: req.production_id,
    kind: "approval_request_result",
    entityType: "approval_request",
    entityId: req.id,
    title: "资源访问申请已过期",
    body: `你申请的${desc}在审批完成前已过所选的到期日期，申请自动结束。如仍需要，请重新提交并选择更晚的日期。`,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "warning",
    approvalRequestId: req.id,
    buildExternalMessage: async () => ({
      text: `你申请的${desc}已过所选到期日期，需重新提交`,
      title: `资源申请已过期`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });
  return true;
}

/**
 * 把申请推进到指定级：给旧末条补落点、追加新级条目、改写 current_*，
 * 并对「当前级」做乐观锁 —— 手动转交与 cron 超时升级可能撞车，
 * WHERE 里带上原级 → 只有一个能成。
 *
 * 补旧条目与追加新条目必须在同一条 SQL 里：分两步做的话，落败的一方会先把
 * 赢家刚写下的新条目当成"旧末条"改掉。
 */
async function advanceToStage(
  req: ApprovalRow,
  stage: ApprovalStage,
  markPrev: Partial<ApprovalChainEntry>,
): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = $2,
         current_stage = $3,
         current_stage_depth = $4,
         current_approver_ids = $5::uuid[],
         escalation_chain =
           CASE WHEN jsonb_array_length(escalation_chain) > 0
                THEN jsonb_set(
                       escalation_chain,
                       ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                       (escalation_chain -> -1) || $10::jsonb)
                ELSE escalation_chain
           END || $6::jsonb
     WHERE id = $1
       AND status = $7
       AND current_stage IS NOT DISTINCT FROM $8
       AND current_stage_depth = $9
     RETURNING id`,
    [
      req.id, stageStatus(stage.stage), stage.stage, stage.depth, stage.approverIds,
      JSON.stringify([chainEntryFor(stage)]),
      req.status, req.current_stage, req.current_stage_depth ?? 0,
      JSON.stringify(markPrev),
    ],
  );
  return rows.length > 0;
}

// 级名文案已上移到 lib/approval-stages.ts —— 通知标题与页面时间线共用一份，
// 不然同一级在飞书里叫「资源持有者」、在页面上叫「资源持有人」。

type StageNotifyContext = "new" | "timeout" | "forwarded";

/**
 * 通知某一级的审批人。无权终局的直属上级拿到的是「转发」而非「批准」。
 *
 * handoffComment = 上一级转交时写下的理由。带上它，下一级才知道为什么轮到自己；
 * 不带的话「由上一级转发」就是一句没有信息量的话。
 */
async function notifyStage(
  req: ApprovalRow,
  stage: ApprovalStage,
  context: StageNotifyContext,
  handoffComment?: string | null,
): Promise<void> {
  if (stage.approverIds.length === 0) return;

  const nameRes = await getPool().query<{ name: string }>(
    `SELECT name FROM user_profile WHERE user_id = $1`,
    [req.subject_id],
  );
  const subjectName = nameRes.rows[0]?.name ?? "成员";
  const desc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  const suffix = context === "timeout"   ? "（上一级审批超时，已自动升级）"
               : context === "forwarded" ? "（由上一级转发）"
               : "";
  const requestId = req.id;

  const actions = stage.canFinalize
    ? [
        { id: "approve", presentation: "primary_button" as const, label: "批准", effects: [{ type: "approve_access_request" as const, requestId }] },
        { id: "reject",  presentation: "secondary_button" as const, label: "拒绝", effects: [{ type: "reject_access_request" as const, requestId }] },
      ]
    : [
        // #140：上级本人没有这个权限 → 只能向上转发，不能批准
        { id: "escalate", presentation: "primary_button" as const, label: "向上转交", effects: [{ type: "escalate_access_request" as const, requestId }] },
        { id: "reject",   presentation: "secondary_button" as const, label: "拒绝",   effects: [{ type: "reject_access_request" as const, requestId }] },
      ];

  const noteLine = req.note ? `\n\n申请理由：${req.note}` : "";
  const handoffLine = handoffComment ? `\n\n上一级转交说明：${handoffComment}` : "";
  const body = stage.canFinalize
    ? `${subjectName} 申请获得${desc}${suffix}，请审批。${noteLine}${handoffLine}`
    : `${subjectName} 申请获得${desc}${suffix}。你本人尚未持有该权限，只能向上转交给下一级审批人。${noteLine}${handoffLine}`;

  await notifyUsers({
    userIds: stage.approverIds,
    productionId: req.production_id,
    kind: "approval_request_pending",
    entityType: "approval_request",
    entityId: requestId,
    title: `${subjectName} 申请 ${desc}${suffix}`,
    body,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "action",
    actionRequired: true,
    approvalRequestId: requestId,
    actions,
    buildExternalMessage: async () => ({
      text: `${subjectName} 申请 ${desc}${suffix}，请处理`,
      title: `资源申请待${stage.canFinalize ? "审批" : "转交"}（${approvalStageLabel(stage.stage, stage.depth)}）`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });
}

/**
 * 审批动作鉴权。返回 canFinalize=false 表示「在场但只能转发」。
 *
 * owner 恒可介入；制作人可介入非敏感申请（PRD：制作人可随时介入本演出待处理
 * 申请）；敏感节点恒过 owner，制作人代批不了。
 */
async function authorizeApprovalAction(
  req: ApprovalRow,
  actorId: string,
): Promise<{ authorized: boolean; canFinalize: boolean }> {
  const ownerRes = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM production WHERE id = $1 AND owner_id = $2) AS ok`,
    [req.production_id, actorId],
  );
  if (ownerRes.rows[0]?.ok) return { authorized: true, canFinalize: true };

  const nodeClass = classifyApprovalNode(
    req.resource_type ?? "", req.resource_sub ?? "*", req.permission_level ?? "",
  );
  if (nodeClass !== "sensitive") {
    const producerRes = await getPool().query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM production_member
         WHERE production_id = $1 AND user_id = $2 AND '制作人' = ANY(roles)
       ) AS ok`,
      [req.production_id, actorId],
    );
    if (producerRes.rows[0]?.ok) return { authorized: true, canFinalize: true };
  }

  if (!(req.current_approver_ids ?? []).includes(actorId)) {
    return { authorized: false, canFinalize: false };
  }
  // 非 supervisor 级恒可终局；supervisor 级按「本人是否持有该权限」现算
  if (req.current_stage !== "supervisor") return { authorized: true, canFinalize: true };

  const ladder = await buildApprovalLadder(approvalTargetOf(req));
  const stage = stageAt(ladder, { stage: "supervisor", depth: req.current_stage_depth ?? 0 });
  return { authorized: true, canFinalize: stage?.canFinalize ?? false };
}

export type SubmitAccessRequestParams = {
  type?: "resource_access" | "atomic_permission";
  resourceType: string;
  resourceId?: string;
  resourceSub?: string;
  permissionLevel: string;
  grantType?: "permanent" | "ttl";
  /** Postgres INTERVAL 字面量，且必须来自 TTL_OPTIONS（lib/approval-ttl.ts）。 */
  ttlDuration?: string | null;
  /** 自定义档位的 ISO 绝对到期时间；与 ttlDuration 二选一。 */
  requestedExpiresAt?: string | null;
  note?: string | null;
};

export async function submitAccessRequest(
  productionId: string,
  userId: string,
  params: SubmitAccessRequestParams,
): Promise<ApprovalRequest> {
  const resourceId = params.resourceId ?? "*";
  const resourceSub = params.resourceSub ?? "*";
  const requestType = params.type ?? "resource_access";
  const grantType = params.grantType ?? "permanent";
  // 固定档位与自定义日期二选一。校验放在这里而非只在路由——任何调用方
  // 都必须经过同一道门，避免 ttl 落成 expires_at=NULL 的永久权限。
  //
  // 互斥要按**存在性**判，不能按「哪个校验通过」判：DB 的
  // approval_request_ttl_source_exclusive 卡的就是存在性，两边口径一错，
  // 「合法 ttlDuration + 垃圾 requestedExpiresAt」这种脏输入会一路穿到
  // Postgres，换来一个 500 而不是 400（AI review #353）。
  // `||` 而非 `??`：空串要归一成 NULL，否则 ''::TIMESTAMPTZ 同样是 500。
  const ttlDuration = grantType === "ttl" ? params.ttlDuration || null : null;
  const requestedExpiresAt = grantType === "ttl" ? params.requestedExpiresAt || null : null;
  if (grantType === "ttl") {
    const hasDuration = ttlDuration !== null;
    const hasCustomExpiry = requestedExpiresAt !== null;
    if (hasDuration === hasCustomExpiry) throw new ApprovalRequestError("invalid_ttl");
    if (hasDuration && !isValidTtlInterval(ttlDuration)) throw new ApprovalRequestError("invalid_ttl");
    if (hasCustomExpiry && !isValidCustomExpiry(requestedExpiresAt)) throw new ApprovalRequestError("invalid_ttl");
  }

  // ROOT 节点（批F 三态）owner-only、连审批通道都没有——申请不该被收下
  if (classifyApprovalNode(params.resourceType, resourceSub, params.permissionLevel) === "root") {
    throw new ApprovalRequestError("no_entry");
  }

  const ladder = await buildApprovalLadder({
    productionId, subjectId: userId,
    resourceType: params.resourceType,
    resourceId, resourceSub,
    permissionLevel: params.permissionLevel,
  });
  const firstStage = ladder[0];
  if (!firstStage) throw new ApprovalRequestError("no_approver");

  // 覆盖式申请自动完成（2026-08-16 用户反馈）：同人同目标同级别的旧 pending 申请
  // 被新申请取代（如先申 1 周又改申 30 天）——自动 cancel 并过期其待办通知，
  // 否则旧申请的审批待办永远挂着，审批人收件箱堆积。
  // 与新申请 INSERT 同事务（AI review）：中途失败不能留"旧的已撤、新的没建"半态；
  // IS NOT DISTINCT FROM 兼容存量 NULL resource_id/sub（新写入恒 '*'，老行可能 NULL）
  const supersedeClient = await getPool().connect();
  let request: ApprovalRow;
  try {
    await supersedeClient.query("BEGIN");
    // 链末条补 cancelled/superseded 必须在**同一条 SQL 同一个事务**里：
    // 走 markLastChainEntry（另取连接）会撞上本事务尚未提交的行锁，直接把自己卡死。
    const supersedeMark: Partial<ApprovalChainEntry> = {
      action: "cancelled",
      actedAt: new Date().toISOString(),
      bySystem: true,
      cancelReason: "superseded",
    };
    const superseded = await supersedeClient.query<{ id: string }>(
      `UPDATE approval_request
       SET status = 'cancelled', resolved_at = now(), resolved_by = $2,
           escalation_chain =
             CASE WHEN jsonb_array_length(escalation_chain) > 0
                  THEN jsonb_set(
                         escalation_chain,
                         ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                         (escalation_chain -> -1) || $8::jsonb)
                  ELSE escalation_chain
             END,
           current_stage = NULL, current_approver_ids = '{}'
       WHERE production_id = $1 AND subject_id = $2 AND type = $3
         AND resource_type = $4
         AND resource_id IS NOT DISTINCT FROM $5
         AND resource_sub IS NOT DISTINCT FROM $6
         AND permission_level = $7
         AND status IN ('pending_supervisor', 'pending_resource')
       RETURNING id`,
      [
        productionId, userId, requestType, params.resourceType, resourceId, resourceSub,
        params.permissionLevel, JSON.stringify(supersedeMark),
      ],
    );
    for (const r of superseded.rows) {
      await supersedeClient.query(
        `UPDATE user_notification SET expired_at = now()
         WHERE approval_request_id = $1 AND expired_at IS NULL AND acted_at IS NULL`,
        [r.id],
      );
    }
    const insertRes = await supersedeClient.query<ApprovalRow>(
      `INSERT INTO approval_request
         (production_id, subject_id, type,
          resource_type, resource_id, resource_sub,
          permission_level, grant_type, ttl_duration, requested_expires_at, note, status,
          current_stage, current_stage_depth, current_approver_ids, escalation_chain)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::INTERVAL,$10::TIMESTAMPTZ,$11,$12,$13,$14,$15::uuid[],$16::jsonb)
       RETURNING *`,
      [
        productionId, userId, requestType,
        params.resourceType, resourceId, resourceSub,
        params.permissionLevel,
        grantType,
        ttlDuration,
        requestedExpiresAt,
        params.note ?? null,
        stageStatus(firstStage.stage),
        firstStage.stage,
        firstStage.depth,
        firstStage.approverIds,
        JSON.stringify([chainEntryFor(firstStage)]),
      ],
    );
    request = insertRes.rows[0];
    await supersedeClient.query("COMMIT");
  } catch (e) {
    await supersedeClient.query("ROLLBACK");
    throw e;
  } finally {
    supersedeClient.release();
  }

  await notifyStage(request, firstStage, "new");
  return rowToApproval(request);
}

export async function approveAccessRequest(
  requestId: string,
  actorId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "unauthorized" | "forward_only" | "expired" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const req = await loadApproval(requestId);
  if (!req) return { ok: false, reason: "not_found" };
  if (!isPendingStatus(req.status)) return { ok: false, reason: "conflict" };

  const auth = await authorizeApprovalAction(req, actorId);
  if (!auth.authorized) return { ok: false, reason: "unauthorized" };
  // 自定义到期日已被跨过：批下去只会发一条出生即失效的授权。放在鉴权之后、
  // forward_only 之前——本级处理不了的人也该看到「这条已经过期」而不是「去转交」。
  if (await cancelIfCustomExpiryPassed(req)) return { ok: false, reason: "expired" };
  // 直属上级本人没有该权限 → 只能转发（#140）
  if (!auth.canFinalize) return { ok: false, reason: "forward_only" };

  // first-action-wins：状态与所在级都要没被别人动过
  // 固定档位从批准时开始计时；自定义日期保持申请人选定的绝对时间。
  const updateRes = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'approved',
         resolved_at = now(),
         resolved_by = $2,
         granted_at = now(),
         current_stage = NULL,
         current_approver_ids = '{}',
         expires_at = CASE WHEN grant_type = 'ttl'
                            THEN COALESCE(requested_expires_at, now() + ttl_duration)
                            ELSE NULL END
     WHERE id = $1 AND status = $3
       AND current_stage IS NOT DISTINCT FROM $4
       AND (requested_expires_at IS NULL OR requested_expires_at > now())
     RETURNING id`,
    [requestId, actorId, req.status, req.current_stage],
  );
  if (!updateRes.rows[0]) return { ok: false, reason: "conflict" };

  await markLastChainEntry(requestId, {
    action: "approved", actorId, actedAt: new Date().toISOString(),
    ...(comment ? { comment } : {}),
  });

  const fresh = await loadApproval(requestId);

  // 终局（批G G-2）：atomic_permission 类型申请已随原子键退役（表已 DROP）——
  // 历史 pending 申请（若有）按无效处理，不再发行
  if (req.type === "atomic_permission") {
    // 原子键机制已退役；生成端已节点化（403 redirect+modal），此处仅防历史 pending。
    console.warn(`[approval] 跳过旧格式 atomic_permission 申请 ${requestId}（不发行）`);
  } else {
    // 批A：REST 化域（cue_list）的伪级别申请在发行时展开为动词行集；
    // 未迁移域仍写单行。蕴含由授权时发多行表达（总表 §0）。
    // 展开表与「上级是否已持有该权限」的判定共用 expandLevelRows，两侧不会漂移。
    const rows = expandLevelRows(req.resource_type ?? "", req.resource_sub ?? "*", req.permission_level ?? "");
    for (const [sub, verb] of rows) {
      await getPool().query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by, approval_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'approval',$7,$8,$9)
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [
          req.production_id,
          req.subject_id,
          req.resource_type,
          req.resource_id ?? "*",
          sub,
          verb,
          actorId,
          requestId,
          fresh?.expires_at ?? null,
        ],
      );
    }
  }

  await expireRequestNotifications(requestId);

  const approvedDesc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  await notifyUser({
    userId: req.subject_id,
    productionId: req.production_id,
    kind: "approval_request_result",
    entityType: "approval_request",
    entityId: requestId,
    title: "资源访问申请已批准",
    body: `你申请的${approvedDesc}已获批准。${comment ? `\n\n审批意见：${comment}` : ""}`,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "info",
    approvalRequestId: requestId,
    buildExternalMessage: async () => ({
      text: `你申请的${approvedDesc}已获批准`,
      title: `资源申请已批准`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });

  const finalRow = fresh ?? (await loadApproval(requestId))!;
  return { ok: true, request: await withApprovalPeople(rowToApproval(finalRow)) };
}

/**
 * 向上转发（#140）：当前级处理不了 —— 直属上级没有该权限，或部门负责人认为
 * 该由上级定 —— 就把申请推到阶梯的下一级。转发不是拒绝，链路完整记在
 * escalation_chain 里。
 */
export async function escalateAccessRequest(
  requestId: string,
  actorId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "unauthorized" | "no_next_stage" | "expired" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const req = await loadApproval(requestId);
  if (!req) return { ok: false, reason: "not_found" };
  if (!isPendingStatus(req.status)) return { ok: false, reason: "conflict" };

  const auth = await authorizeApprovalAction(req, actorId);
  if (!auth.authorized) return { ok: false, reason: "unauthorized" };
  // 往上转交一条已经作废的申请，只是把它挪到下一位审批人的收件箱里继续烂着
  if (await cancelIfCustomExpiryPassed(req)) return { ok: false, reason: "expired" };

  const ladder = await buildApprovalLadder(approvalTargetOf(req));
  const next = nextStage(ladder, currentPositionOf(req));
  if (!next) return { ok: false, reason: "no_next_stage" };

  const moved = await advanceToStage(req, next, {
    action: "escalated", actorId, actedAt: new Date().toISOString(), escalationReason: "forwarded",
    ...(comment ? { comment } : {}),
  });
  if (!moved) return { ok: false, reason: "conflict" };

  await expireRequestNotifications(requestId);
  const fresh = await loadApproval(requestId);
  if (fresh) await notifyStage(fresh, next, "forwarded", comment);

  return { ok: true, request: await withApprovalPeople(rowToApproval(fresh ?? req)) };
}

export async function rejectAccessRequest(
  requestId: string,
  actorId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "unauthorized" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const req = await loadApproval(requestId);
  if (!req) return { ok: false, reason: "not_found" };
  if (!isPendingStatus(req.status)) return { ok: false, reason: "conflict" };

  const auth = await authorizeApprovalAction(req, actorId);
  if (!auth.authorized) return { ok: false, reason: "unauthorized" };

  const updateRes = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'rejected', resolved_at = now(), resolved_by = $2,
         current_stage = NULL, current_approver_ids = '{}'
     WHERE id = $1 AND status = $3
     RETURNING id`,
    [requestId, actorId, req.status],
  );
  if (!updateRes.rows[0]) return { ok: false, reason: "conflict" };

  await markLastChainEntry(requestId, {
    action: "rejected", actorId, actedAt: new Date().toISOString(),
    ...(comment ? { comment } : {}),
  });
  await expireRequestNotifications(requestId);

  const rejectedDesc = await describeResource(req.resource_type ?? "", req.resource_id ?? "*", req.permission_level ?? "");
  await notifyUser({
    userId: req.subject_id,
    productionId: req.production_id,
    kind: "approval_request_result",
    entityType: "approval_request",
    entityId: requestId,
    title: "资源访问申请被拒绝",
    body: `你申请的${rejectedDesc}未获批准。${comment ? `\n\n拒绝理由：${comment}` : ""}`,
    viewHref: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    category: "warning",
    approvalRequestId: requestId,
    buildExternalMessage: async () => ({
      text: `你申请的${rejectedDesc}未获批准`,
      title: `资源申请被拒绝`,
      primaryUrl: `${SERVER_URL}/production/${req.production_id}/access-requests`,
    }),
  });

  const finalRow = await loadApproval(requestId);
  return { ok: true, request: await withApprovalPeople(rowToApproval(finalRow ?? req)) };
}

/**
 * 申请人撤回自己的申请。
 *
 * resolved_by 必须写：撤回也是「谁在什么时候结束了这条申请」，不写的话时间线上
 * 的终结节点没有人，看着像系统自己结的。链末条同时补 action='cancelled' ——
 * 那一级是**没处理**，不是还在等；不补的话前端只能看到一个没有动作的末条，
 * 只好按「等待中」画成灰点，读起来像申请还挂在那些人手上。
 */
export async function cancelAccessRequest(
  requestId: string,
  userId: string,
  rawComment?: string | null,
): Promise<
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "conflict" | "comment_too_long" }
> {
  const comment = normalizeApprovalComment(rawComment);
  if (isApprovalCommentTooLong(comment)) return { ok: false, reason: "comment_too_long" };

  const res = await getPool().query<{ id: string }>(
    `UPDATE approval_request
     SET status = 'cancelled', resolved_at = now(), resolved_by = $2,
         current_stage = NULL, current_approver_ids = '{}'
     WHERE id = $1
       AND subject_id = $2
       AND status IN ('pending_supervisor', 'pending_resource')
     RETURNING id`,
    [requestId, userId],
  );
  if (!res.rows[0]) {
    const exists = await getPool().query(`SELECT 1 FROM approval_request WHERE id = $1`, [requestId]);
    return exists.rows[0] ? { ok: false, reason: "conflict" } : { ok: false, reason: "not_found" };
  }

  await markLastChainEntry(requestId, {
    action: "cancelled", actorId: userId, actedAt: new Date().toISOString(),
    cancelReason: "by_subject",
    ...(comment ? { comment } : {}),
  });
  await expireRequestNotifications(requestId);

  const finalRow = await loadApproval(requestId);
  return { ok: true, request: await withApprovalPeople(rowToApproval(finalRow!)) };
}

export async function listMyAccessRequests(
  productionId: string,
  userId: string,
): Promise<ApprovalRequest[]> {
  const res = await getPool().query<ApprovalRow>(
    `SELECT ar.*, COALESCE(NULLIF(up.display_name, ''), up.name, '成员') AS subject_name
     FROM approval_request ar
     LEFT JOIN user_profile up ON up.user_id = ar.subject_id
     WHERE ar.production_id = $1 AND ar.subject_id = $2
     ORDER BY ar.created_at DESC`,
    [productionId, userId],
  );
  return attachApprovalPeople(res.rows.map(rowToApproval));
}

/**
 * 我的待办：只读 current_approver_ids（路由已在写入时算好）。
 * canFinalize 取自当前级的链条目——false 表示前端该显示「转发」而非「批准」。
 */
export async function listPendingApprovals(
  actorId: string,
  productionId?: string,
): Promise<ApprovalRequest[]> {
  const params: unknown[] = [actorId];
  const prodClause = productionId
    ? `AND ar.production_id = $${params.push(productionId)}`
    : "";

  const res = await getPool().query<ApprovalRow>(
    `SELECT ar.*, COALESCE(NULLIF(up.display_name, ''), up.name, '成员') AS subject_name
     FROM approval_request ar
     LEFT JOIN user_profile up ON up.user_id = ar.subject_id
     WHERE ar.status IN ('pending_supervisor', 'pending_resource')
       AND ar.current_approver_ids @> ARRAY[$1]::uuid[]
     ${prodClause}
     ORDER BY ar.created_at ASC`,
    params,
  );
  return attachApprovalPeople(res.rows.map((r) => {
    const approval = rowToApproval(r);
    const last = approval.escalationChain[approval.escalationChain.length - 1];
    return { ...approval, canFinalize: last?.canFinalize ?? true };
  }));
}

// ─── 审批链预览（提交前）────────────────────────────────────────────────────────

export type ApprovalLadderPreviewStage = {
  stage: ApprovalStageName;
  depth: number;
  /** 该级能否直接终局。false = 只能向上转交（直属上级本人没有这个权限）。 */
  canFinalize: boolean;
  approverIds: string[];
};

export type ApprovalLadderPreview = {
  /** root = 无审批通道（提交也会被拒收）；sensitive = 跳过整条链直达 owner。 */
  nodeClass: ApprovalNodeClass;
  stages: ApprovalLadderPreviewStage[];
  people: Record<string, ApprovalPerson>;
};

/**
 * 提交前预览这条申请会走的审批链。
 *
 * **这是预测不是快照**：阶梯由 buildApprovalLadder 按**此刻**的汇报关系、资源持有者、
 * 部门 POC 现算，真正提交后每次升级都会重算一遍。中间任何人事变动都会让实际链路
 * 与这份预览不同——消费方必须把它呈现为「预计」，不能当成承诺。
 *
 * nodeClass 是这个接口的另一半价值：ROOT 节点在提交时会被 no_entry 拒收，
 * 让人填完整张表才吃 403 是白填；预览一眼就能说清楚"这个权限没有申请通道"。
 */
export async function previewApprovalLadder(
  productionId: string,
  subjectId: string,
  params: { resourceType: string; resourceId?: string; resourceSub?: string; permissionLevel: string },
): Promise<ApprovalLadderPreview> {
  const target: ApprovalTarget = {
    productionId,
    subjectId,
    resourceType: params.resourceType,
    resourceId: params.resourceId ?? "*",
    resourceSub: params.resourceSub ?? "*",
    permissionLevel: params.permissionLevel,
  };
  const nodeClass = classifyApprovalNode(target.resourceType, target.resourceSub, target.permissionLevel);
  // ROOT 连审批通道都没有——buildApprovalLadder 对它返回空阶梯，不必白跑一趟查询
  const ladder = nodeClass === "root" ? [] : await buildApprovalLadder(target);

  const stages = ladder.map((s) => ({
    stage: s.stage, depth: s.depth, canFinalize: s.canFinalize, approverIds: s.approverIds,
  }));
  const people = await loadApprovalPeople(
    productionId,
    [...new Set(stages.flatMap((s) => s.approverIds))],
  );
  return { nodeClass, stages, people };
}


/** Called by the internal cron endpoint — 当前级超时未响应即升级到阶梯下一级。 */
export async function escalateExpiredApprovals(): Promise<{ escalated: number }> {
  // 计时起点是「当前级被通知的时刻」（链末条 notifiedAt），不是申请创建时刻——
  // 否则五级阶梯会在同一个 TTL 里被连着跳完。
  //
  // LEFT JOIN + COALESCE 而非 INNER JOIN：production_approval_config 是 Phase 3
  // 才加的表，建表 SQL 没有回填，早于它的演出一行都没有。INNER JOIN 会让这些
  // 演出的申请**永远**匹配不上、一次也升不了级（线上 8 个演出全部缺行，整条
  // 升级链自 Phase 7 起就是死的）。缺配置=按列默认值计时，不是"不升级"。
  const { rows } = await getPool().query<ApprovalRow>(
    `SELECT ar.* FROM approval_request ar
     LEFT JOIN production_approval_config pac ON pac.production_id = ar.production_id
     WHERE ar.status IN ('pending_supervisor', 'pending_resource')
       AND COALESCE((ar.escalation_chain -> -1 ->> 'notifiedAt')::timestamptz, ar.created_at)
           < now() - (COALESCE(pac.ttl_hours, $1) || ' hours')::INTERVAL`,
    [DEFAULT_APPROVAL_TTL_HOURS],
  );

  let escalated = 0;
  for (const row of rows) {
    const ladder = await buildApprovalLadder(approvalTargetOf(row));
    const next = nextStage(ladder, currentPositionOf(row));
    if (!next) continue;  // 已在链顶（owner），只等人处理，不再升级

    // bySystem：超时升级没有操作人。少了这面旗，消费方只能看到一条有 action
    // 却没有 actorId 的条目，无法区分「系统自动升级」与「数据缺了操作人」。
    const moved = await advanceToStage(row, next, {
      action: "escalated", actedAt: new Date().toISOString(),
      escalationReason: "timeout", bySystem: true,
    });
    if (!moved) continue;
    escalated++;

    await expireRequestNotifications(row.id);
    const fresh = await loadApproval(row.id);
    if (fresh) await notifyStage(fresh, next, "timeout");
  }

  return { escalated };
}
