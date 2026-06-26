import { getPool } from "./pg";
import type { PoolClient } from "pg";
import { readFile } from "fs/promises";
import type { Block, Character, Scene, ScriptState, ScriptConfig, PageLayout, MarkerMeta } from "./script-types";
import { DEFAULT_SCRIPT_CONFIG } from "./script-types";
import type { Permission, PermissionOverrides } from "./roles";
import type { Cue, CueAnchor } from "./cue-types";
import { adjustBlockAnchor, lcsAdjust } from "./cue-types";
import type { ScriptPatch, TagEntry } from "./script-ops";
import { keyBetween, initialKeys } from "./lex-order";
import { computePageMap } from "./script-page";
import { generatedRehearsalMarksByScene, withGeneratedSceneNumbers } from "./script-generated-labels";
import { VERSION_OWNED_BLOCKS_CTE, VERSION_SCENES_FROM_MARKERS_CTE } from "./script-marker-sql";
import { FIXED_INITIAL_CHAPTER_BLOCK_ID } from "./script-fixed-markers";

type MarkerMigrationState = {
  status: "idle" | "running" | "failed";
  error: string | null;
  startedAt: number | null;
  progress: number;
  phase: string;
  estimatedTotalMs: number | null;
};

const markerMigrationState: MarkerMigrationState = (
  globalThis as typeof globalThis & { __scriptMarkerMigrationState?: MarkerMigrationState }
).__scriptMarkerMigrationState ??= {
  status: "idle",
  error: null,
  startedAt: null,
  progress: 0,
  phase: "",
  estimatedTotalMs: null,
};
markerMigrationState.estimatedTotalMs ??= null;

const markerMigrationNeededChecks = new Map<string, Promise<boolean>>();

export type MarkerMigrationProgress = {
  status: "ready" | "running" | "failed";
  progress: number;
  phase: string;
  startedAt: number | null;
  elapsedMs: number;
  estimatedTotalMs: number | null;
  estimatedRemainingMs: number | null;
};

function markerMigrationProgress(status: "ready" | "running" | "failed" = markerMigrationState.status === "running" ? "running" : markerMigrationState.status === "failed" ? "failed" : "ready"): MarkerMigrationProgress {
  const startedAt = markerMigrationState.startedAt;
  const elapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  const progress = status === "ready"
    ? 100
    : Math.max(1, Math.min(99, markerMigrationState.progress || 1));
  const estimatedTotalMs = markerMigrationState.estimatedTotalMs;
  const estimatedRemainingMs = status === "running" && estimatedTotalMs !== null
    ? Math.max(1000, estimatedTotalMs - elapsedMs)
    : null;
  return {
    status,
    progress,
    phase: status === "ready" ? "更新完成" : markerMigrationState.phase || "准备更新数据",
    startedAt,
    elapsedMs,
    estimatedTotalMs,
    estimatedRemainingMs,
  };
}

// ─── Version types ────────────────────────────────────────────────────────────

export type VersionStatus = 'editing' | 'committed' | 'frozen' | 'archived';

export type Version = {
  id: string;
  productionId: string;
  name: string;
  description: string;
  tags: string[];
  parentVersionId: string | null;
  status: VersionStatus;
  createdAt: string;
};

// ─── Exported types ───────────────────────────────────────────────────────────

export type DbBlock = Block & { orderKey: number; lexKey: string };
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
  marker_meta: MarkerMeta | null;
  type: DbBlockType;
  content: string;
  stage_comment: string | null;
  force_show_character_name: boolean;
};
type SceneRow = { id: string; num: string; name: string; sort_order: number; parent_id: string | null };
type CharRow  = { id: string; name: string; sort_order: number; is_aggregate: boolean; member_ids: string[] | null };
// script_character uses snapshot_id as the script_id FK
type ScCharRow = { script_id: string; character_id: string; annotation: string | null };

function cleanMarkerMeta(meta: MarkerMeta | null | undefined): MarkerMeta {
  if (!meta || typeof meta !== "object") return {};
  return {
    number: typeof meta.number === "string" ? meta.number : undefined,
    name: typeof meta.name === "string" ? meta.name : undefined,
    parentMarkerId: typeof meta.parentMarkerId === "string" ? meta.parentMarkerId : meta.parentMarkerId === null ? null : undefined,
    synopsis: typeof meta.synopsis === "string" ? meta.synopsis : undefined,
    actionLine: typeof meta.actionLine === "string" ? meta.actionLine : undefined,
    music: typeof meta.music === "string" ? meta.music : undefined,
    stageNotes: typeof meta.stageNotes === "string" ? meta.stageNotes : undefined,
    expectedDuration: typeof meta.expectedDuration === "string" ? meta.expectedDuration : undefined,
  };
}

function markerMetaJson(block: Block): string {
  return JSON.stringify(cleanMarkerMeta(block.markerMeta));
}

async function scriptMarkerMigrationNeeded(versionId: string): Promise<boolean> {
  const res = await getPool().query<{ needed: boolean }>(
    `WITH marker_rows AS (
       SELECT
         sv.version_id,
         sv.block_id AS marker_block_id,
         s.id AS marker_snapshot_id,
         s.scene_id AS legacy_scene_id,
         s.marker_meta,
         s.type::text AS marker_type
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
         AND s.type IN ('chapter_marker', 'scene_marker')
     ),
     counts AS (
       SELECT
         COUNT(*) - COUNT(DISTINCT (sv.version_id, sv.block_id)) AS duplicate_version_block_count,
         COUNT(*) FILTER (
           WHERE s.type IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
         ) AS marker_count,
         COUNT(*) FILTER (
           WHERE s.type NOT IN ('chapter_marker', 'scene_marker', 'rehearsal_marker')
             AND (s.scene_id IS NOT NULL OR s.rehearsal_mark IS NOT NULL)
         ) AS legacy_owned_count
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
     ),
     orphan_scene_versions AS (
       SELECT COUNT(*) AS cnt
       FROM scene_version scene_v
       LEFT JOIN marker_rows marker
         ON marker.version_id = scene_v.version_id
        AND scene_v.scene_id IN (marker.marker_block_id, marker.legacy_scene_id)
       WHERE scene_v.version_id = $1
         AND marker.marker_block_id IS NULL
         AND COALESCE(
           NULLIF(scene_v.name, ''),
           NULLIF(scene_v.synopsis, ''),
           NULLIF(scene_v.action_line, ''),
           NULLIF(scene_v.music, ''),
           NULLIF(scene_v.stage_notes, ''),
           NULLIF(scene_v.expected_duration, '')
         ) IS NOT NULL
     ),
     unsynced_marker_meta AS (
       SELECT COUNT(*) AS cnt
       FROM marker_rows marker
       JOIN scene_version scene_v
         ON scene_v.version_id = marker.version_id
        AND scene_v.scene_id IN (marker.marker_block_id, marker.legacy_scene_id)
       WHERE marker.version_id = $1
         AND (
           (NULLIF(scene_v.num, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'number', '') IS NULL)
           OR (NULLIF(scene_v.name, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'name', '') IS NULL)
           OR (NULLIF(scene_v.synopsis, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'synopsis', '') IS NULL)
           OR (NULLIF(scene_v.action_line, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'actionLine', '') IS NULL)
           OR (NULLIF(scene_v.music, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'music', '') IS NULL)
           OR (NULLIF(scene_v.stage_notes, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'stageNotes', '') IS NULL)
           OR (NULLIF(scene_v.expected_duration, '') IS NOT NULL AND NULLIF(marker.marker_meta->>'expectedDuration', '') IS NULL)
         )
     ),
     marker_counts AS (
       SELECT
         COUNT(*) FILTER (WHERE marker_type = 'chapter_marker') AS chapter_count,
         COUNT(*) FILTER (WHERE marker_type = 'scene_marker') AS scene_count
       FROM marker_rows
     ),
     legacy_scene_marker_mismatch AS (
       SELECT COUNT(*) AS cnt
       FROM marker_rows marker
       JOIN scene_version scene_v
         ON scene_v.version_id = marker.version_id
        AND scene_v.scene_id IN (marker.marker_block_id, marker.legacy_scene_id)
       WHERE marker.version_id = $1
         AND marker.marker_type = 'chapter_marker'
         AND marker.marker_block_id <> '__fixed_initial_chapter_marker'
         AND (SELECT chapter_count > 1 FROM marker_counts)
         AND btrim(scene_v.num) ~ '^[0-9]+\\s*-\\s*[0-9]+'
         AND COALESCE(
           NULLIF(scene_v.num, ''),
           NULLIF(scene_v.name, ''),
           NULLIF(scene_v.synopsis, ''),
           NULLIF(scene_v.action_line, ''),
           NULLIF(scene_v.music, ''),
           NULLIF(scene_v.stage_notes, ''),
           NULLIF(scene_v.expected_duration, '')
         ) IS NOT NULL
     ),
     marker_meta_scene_mismatch AS (
       SELECT COUNT(*) AS cnt
       FROM marker_rows marker
       WHERE marker.version_id = $1
         AND marker.marker_type = 'chapter_marker'
         AND marker.marker_block_id <> '__fixed_initial_chapter_marker'
         AND (SELECT chapter_count > 1 FROM marker_counts)
         AND btrim(marker.marker_meta->>'number') ~ '^[0-9]+\\s*-\\s*[0-9]+'
     ),
     empty_generated_marker_placeholders AS (
       SELECT COUNT(*) AS cnt
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       LEFT JOIN scene_version source_sv
         ON source_sv.version_id = sv.version_id
        AND source_sv.scene_id = sv.block_id
       WHERE sv.version_id = $1
         AND sv.snapshot_id LIKE 'sn_orphan_marker_%'
         AND s.type IN ('chapter_marker', 'scene_marker')
         AND COALESCE(
           NULLIF(source_sv.name, ''),
           NULLIF(source_sv.synopsis, ''),
           NULLIF(source_sv.action_line, ''),
           NULLIF(source_sv.music, ''),
           NULLIF(source_sv.stage_notes, ''),
           NULLIF(source_sv.expected_duration, ''),
           NULLIF(s.marker_meta->>'name', ''),
           NULLIF(s.marker_meta->>'synopsis', ''),
           NULLIF(s.marker_meta->>'actionLine', ''),
           NULLIF(s.marker_meta->>'music', ''),
           NULLIF(s.marker_meta->>'stageNotes', ''),
           NULLIF(s.marker_meta->>'expectedDuration', '')
         ) IS NULL
     )
     SELECT (
       (SELECT duplicate_version_block_count > 0 FROM counts)
       OR (SELECT marker_count = 0 AND legacy_owned_count > 0 FROM counts)
       OR (SELECT cnt > 0 FROM orphan_scene_versions)
       OR (SELECT cnt > 0 FROM unsynced_marker_meta)
       OR (SELECT cnt > 0 FROM legacy_scene_marker_mismatch)
       OR (SELECT cnt > 0 FROM marker_meta_scene_mismatch)
       OR (SELECT cnt > 0 FROM empty_generated_marker_placeholders)
     ) AS needed`,
    [versionId]
  );
  return res.rows[0]?.needed ?? false;
}

async function scriptMarkerMigrationNeededOnce(versionId: string): Promise<boolean> {
  const existing = markerMigrationNeededChecks.get(versionId);
  if (existing) return existing;
  const check = scriptMarkerMigrationNeeded(versionId).finally(() => {
    markerMigrationNeededChecks.delete(versionId);
  });
  markerMigrationNeededChecks.set(versionId, check);
  return check;
}

async function runScriptMarkerMigration(): Promise<void> {
  markerMigrationState.phase = "正在统计剧本数据量，耗时取决于数据库大小";
  markerMigrationState.progress = 5;
  const rawSql = await readFile(`${process.cwd()}/db/migrate-script-marker-blocks.sql`, "utf8");
  markerMigrationState.progress = 15;
  markerMigrationState.phase = "正在更新旧格式数据，耗时取决于数据库大小";
  const appSafeSql = rawSql
    .replace(/ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'chapter_marker';/g, "")
    .replace(/ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'scene_marker';/g, "")
    .replace(/ALTER TYPE block_type ADD VALUE IF NOT EXISTS 'rehearsal_marker';/g, "")
    .replace(/ALTER TABLE script ADD COLUMN IF NOT EXISTS marker_meta JSONB NOT NULL DEFAULT '\{\}';/g, "")
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS script_version_version_block_uidx\s+ON script_version\(version_id, block_id\);/g, "");
  await getPool().query(appSafeSql);
  markerMigrationState.progress = 95;
  markerMigrationState.phase = "正在完成数据校验";
}

export async function ensureScriptMarkerMigration(versionId: string): Promise<MarkerMigrationProgress> {
  if (markerMigrationState.status === "running") return markerMigrationProgress("running");
  if (markerMigrationState.status === "failed" && markerMigrationState.error) {
    markerMigrationState.status = "idle";
    markerMigrationState.error = null;
    markerMigrationState.startedAt = null;
    markerMigrationState.progress = 0;
    markerMigrationState.phase = "";
    markerMigrationState.estimatedTotalMs = null;
  }
  const needed = await scriptMarkerMigrationNeededOnce(versionId);
  if (!needed) {
    return markerMigrationProgress("ready");
  }

  markerMigrationState.status = "running";
  markerMigrationState.error = null;
  markerMigrationState.startedAt = Date.now();
  markerMigrationState.progress = 2;
  markerMigrationState.phase = "正在统计剧本数据量，耗时取决于数据库大小";
  markerMigrationState.estimatedTotalMs = null;
  void runScriptMarkerMigration()
    .then(() => {
      markerMigrationState.status = "idle";
      markerMigrationState.error = null;
      markerMigrationState.startedAt = null;
      markerMigrationState.progress = 100;
      markerMigrationState.phase = "更新完成";
      markerMigrationState.estimatedTotalMs = null;
    })
    .catch((err) => {
      markerMigrationState.status = "failed";
      markerMigrationState.error = err instanceof Error ? err.message : String(err);
      markerMigrationState.progress = Math.max(markerMigrationState.progress, 1);
      markerMigrationState.phase = "更新失败";
      markerMigrationState.estimatedTotalMs = null;
      console.error("[marker migration] failed:", err);
    });
  return markerMigrationProgress("running");
}

async function syncSceneVersionsFromMarkersInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
): Promise<void> {
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
             NULLIF(marker_meta->>'number', ''),
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
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     ),
     upserted AS (
       INSERT INTO scene_version (
         scene_id, version_id, num, name, sort_order, parent_id,
         synopsis, action_line, music, stage_notes, expected_duration
       )
       SELECT
         ms.scene_id,
         $1,
         COALESCE(ms.marker_meta->>'number', ''),
         COALESCE(ms.marker_meta->>'name', ''),
         ms.sort_order,
         ms.parent_id,
         ms.marker_meta->>'synopsis',
         ms.marker_meta->>'actionLine',
         ms.marker_meta->>'music',
         ms.marker_meta->>'stageNotes',
         ms.marker_meta->>'expectedDuration'
       FROM marker_scenes ms
       ON CONFLICT (scene_id, version_id) DO UPDATE
         SET num = EXCLUDED.num,
             name = EXCLUDED.name,
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
    [versionId, productionId]
  );
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
    [versionId]
  );
  await normalizeSceneOwnershipOrderInTx(client, versionId);
}

function isChapterSceneMarkerType(type: string | null | undefined): boolean {
  return type === "chapter_marker" || type === "scene_marker";
}


// ─── Version CRUD ─────────────────────────────────────────────────────────────

type VersionRow = {
  id: string;
  production_id: string;
  name: string;
  description: string;
  tags: string[];
  parent_version_id: string | null;
  status: VersionStatus;
  created_at: Date;
};

function rowToVersion(r: VersionRow): Version {
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    description: r.description,
    tags: r.tags,
    parentVersionId: r.parent_version_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listVersions(productionId: string): Promise<Version[]> {
  const res = await getPool().query<VersionRow>(
    "SELECT id, production_id, name, description, tags, parent_version_id, status, created_at FROM version WHERE production_id = $1 ORDER BY created_at",
    [productionId]
  );
  return res.rows.map(rowToVersion);
}

export async function getVersion(versionId: string): Promise<Version | null> {
  const res = await getPool().query<VersionRow>(
    "SELECT id, production_id, name, description, tags, parent_version_id, status, created_at FROM version WHERE id = $1",
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
export async function createInitialVersion(productionId: string): Promise<string> {
  const versionId = genVersionId();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO version (id, production_id, name, status) VALUES ($1, $2, '初稿', 'editing')",
      [versionId, productionId]
    );
    await client.query(
      "UPDATE production SET active_version_id = $1 WHERE id = $2",
      [versionId, productionId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return versionId;
}

/**
 * Creates a new Editing version branched from fromVersionId.
 * If fromVersionId is currently Editing, it is auto-committed first.
 * Content (blocks, scenes, characters, cues) is copied from fromVersionId.
 */
export async function createVersion(
  productionId: string,
  fromVersionId: string,
  name: string,
): Promise<Version> {
  const newVersionId = genVersionId();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const parentRes = await client.query<{ status: string; production_id: string }>(
      "SELECT status, production_id FROM version WHERE id = $1",
      [fromVersionId]
    );
    const parent = parentRes.rows[0];
    if (!parent || parent.production_id !== productionId) {
      throw new Error("Source version does not belong to production");
    }
    const parentStatus = parent.status;

    if (parentStatus === 'editing') {
      await client.query(
        "UPDATE version SET status = 'committed' WHERE id = $1",
        [fromVersionId]
      );
    }

    const nowRes = await client.query<{ now: Date }>("SELECT now() AS now");
    const now = nowRes.rows[0].now;

    await client.query(
      "INSERT INTO version (id, production_id, name, parent_version_id, status, created_at) VALUES ($1, $2, $3, $4, 'editing', $5)",
      [newVersionId, productionId, name, fromVersionId, now]
    );

    // Copy script blocks (same snapshots, new version entry)
    await client.query(
      "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) SELECT snapshot_id, $1, block_id, sort_key FROM script_version WHERE version_id = $2",
      [newVersionId, fromVersionId]
    );

    // Copy cue revisions
    await client.query(
      "INSERT INTO cue_version (revision_id, version_id, cue_id) SELECT revision_id, $1, cue_id FROM cue_version WHERE version_id = $2",
      [newVersionId, fromVersionId]
    );

    // Copy scene and character snapshots
    await client.query(
      `INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id,
                                  synopsis, action_line, music, stage_notes, expected_duration)
       SELECT scene_id, $1, num, name, sort_order, parent_id,
              synopsis, action_line, music, stage_notes, expected_duration
       FROM scene_version WHERE version_id = $2`,
      [newVersionId, fromVersionId]
    );
    await client.query(
      `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate, gender, biography, role_type)
       SELECT character_id, $1, name, sort_order, is_aggregate, gender, biography, role_type FROM character_version WHERE version_id = $2`,
      [newVersionId, fromVersionId]
    );

    // Copy asset version relations
    await client.query(
      `INSERT INTO asset_version_rel (asset_id, version_id, asset_file_id)
       SELECT asset_id, $1, asset_file_id FROM asset_version_rel WHERE version_id = $2
       ON CONFLICT (asset_id, version_id) DO NOTHING`,
      [newVersionId, fromVersionId]
    );

    await client.query(
      "UPDATE production SET active_version_id = $1 WHERE id = $2",
      [newVersionId, productionId]
    );

    await client.query("COMMIT");
    return {
      id: newVersionId,
      productionId,
      name,
      description: '',
      tags: [],
      parentVersionId: fromVersionId,
      status: 'editing',
      createdAt: now.toISOString(),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rollback: commits the current editing version, then creates a new editing
 * version with the content of targetVersionId. Parent of the new version is
 * the current version (not the target).
 */
export async function rollbackToVersion(
  currentVersionId: string,
  targetVersionId: string,
  productionId: string,
  name: string,
): Promise<Version> {
  const newVersionId = genVersionId();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const versionOwnerRes = await client.query<{ current_owner: string | null; target_owner: string | null }>(
      `SELECT
         (SELECT production_id FROM version WHERE id = $1) AS current_owner,
         (SELECT production_id FROM version WHERE id = $2) AS target_owner`,
      [currentVersionId, targetVersionId]
    );
    const owners = versionOwnerRes.rows[0];
    if (owners?.current_owner !== productionId || owners?.target_owner !== productionId) {
      throw new Error("Rollback versions do not belong to production");
    }

    await client.query(
      "UPDATE version SET status = 'committed' WHERE id = $1",
      [currentVersionId]
    );

    const nowRes = await client.query<{ now: Date }>("SELECT now() AS now");
    const now = nowRes.rows[0].now;

    await client.query(
      "INSERT INTO version (id, production_id, name, parent_version_id, status, created_at) VALUES ($1, $2, $3, $4, 'editing', $5)",
      [newVersionId, productionId, name, currentVersionId, now]
    );

    // Copy content from targetVersionId (not currentVersionId)
    await client.query(
      "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) SELECT snapshot_id, $1, block_id, sort_key FROM script_version WHERE version_id = $2",
      [newVersionId, targetVersionId]
    );

    await client.query(
      "INSERT INTO cue_version (revision_id, version_id, cue_id) SELECT revision_id, $1, cue_id FROM cue_version WHERE version_id = $2",
      [newVersionId, targetVersionId]
    );

    // Copy scene and character snapshots from the target (rollback source) version
    await client.query(
      `INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id,
                                  synopsis, action_line, music, stage_notes, expected_duration)
       SELECT scene_id, $1, num, name, sort_order, parent_id,
              synopsis, action_line, music, stage_notes, expected_duration
       FROM scene_version WHERE version_id = $2`,
      [newVersionId, targetVersionId]
    );
    await client.query(
      `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate, gender, biography, role_type)
       SELECT character_id, $1, name, sort_order, is_aggregate, gender, biography, role_type FROM character_version WHERE version_id = $2`,
      [newVersionId, targetVersionId]
    );

    await client.query(
      `INSERT INTO asset_version_rel (asset_id, version_id, asset_file_id)
       SELECT asset_id, $1, asset_file_id FROM asset_version_rel WHERE version_id = $2
       ON CONFLICT (asset_id, version_id) DO NOTHING`,
      [newVersionId, targetVersionId]
    );

    await client.query(
      "UPDATE production SET active_version_id = $1 WHERE id = $2",
      [newVersionId, productionId]
    );

    await client.query("COMMIT");
    return {
      id: newVersionId,
      productionId,
      name,
      description: '',
      tags: [],
      parentVersionId: currentVersionId,
      status: 'editing',
      createdAt: now.toISOString(),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateVersionMeta(
  productionId: string,
  versionId: string,
  fields: { name?: string; description?: string; tags?: string[] },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [versionId];
  if (fields.name        !== undefined) sets.push(`name        = $${vals.push(fields.name)}`);
  if (fields.description !== undefined) sets.push(`description = $${vals.push(fields.description)}`);
  if (fields.tags        !== undefined) sets.push(`tags        = $${vals.push(fields.tags)}`);
  if (!sets.length) return;
  await getPool().query(
    `UPDATE version SET ${sets.join(', ')} WHERE id = $1 AND production_id = $${vals.push(productionId)}`,
    vals
  );
}

export async function updateVersionStatus(
  productionId: string,
  versionId: string,
  status: 'committed' | 'frozen' | 'archived',
): Promise<void> {
  if (status === 'frozen') {
    // Freeze the target version and all its ancestors (except archived ones).
    await getPool().query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_version_id, production_id FROM version WHERE id = $1 AND production_id = $2
         UNION ALL
         SELECT v.id, v.parent_version_id, v.production_id FROM version v
         JOIN ancestors a ON v.id = a.parent_version_id
         WHERE v.production_id = a.production_id
       )
       UPDATE version SET status = 'frozen'
       WHERE id IN (SELECT id FROM ancestors)
         AND status != 'archived'`,
      [versionId, productionId]
    );
  } else {
    await getPool().query(
      "UPDATE version SET status = $1 WHERE id = $2 AND production_id = $3",
      [status, versionId, productionId]
    );
  }
}

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
                COALESCE(ms.marker_meta->>'number', '') AS num,
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
    pool.query<{ script_config: ScriptConfig | null }>(
      `SELECT p.script_config
       FROM production p
       JOIN version v ON v.production_id = p.id
       WHERE p.id = $1 AND v.id = $2`,
      [productionId, versionId]
    ),
  ]);

  if (!prodRes.rows.length) return null;
  const rawConfig = prodRes.rows[0]?.script_config;

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
          markerMeta: cleanMarkerMeta(row.marker_meta),
          characterIds: charsBySnapshot.get(row.snapshot_id) ?? [],
          characterAnnotations: annotationsBySnapshot.get(row.snapshot_id) ?? {},
        };
  });

  const config: ScriptConfig = { ...DEFAULT_SCRIPT_CONFIG, ...(rawConfig ?? {}) };

  return {
    state: {
      blocks,
      scenes: scenesRes.rows.map(r => ({ id: r.id, number: r.num, name: r.name, parentId: r.parent_id })),
      characters: charsRes.rows.map(r => ({ id: r.id, name: r.name, isAggregate: r.is_aggregate, memberIds: r.member_ids ?? [] })),
      config,
    },
    sortKeys,
    snapshotIds,
  };
}

export async function saveScriptConfig(productionId: string, config: ScriptConfig): Promise<void> {
  await getPool().query(
    "UPDATE production SET script_config = $1 WHERE id = $2",
    [JSON.stringify(config), productionId]
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
  await getPool().query(
    "UPDATE production SET page_map = $1 WHERE id = $2",
    [JSON.stringify(pageMap), productionId]
  );
}

// ─── Write ────────────────────────────────────────────────────────────────────

function genSnapshotId(): string {
  return `sn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
  const { upsertBlocks, deleteSnapshotIds, upsertChars, deleteCharIds, upsertScenes, deleteSceneIds } = payload;
  const newSnapshotIds = new Map<string, string>();

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

    // Scenes: ensure identity row exists in scene (FK anchor), then upsert versioned data
    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertScenes.map(s => s.id), productionId]
      );
      await client.query(
        `INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]), unnest($5::int[]), unnest($6::text[])
         ON CONFLICT (scene_id, version_id) DO UPDATE
           SET num = EXCLUDED.num, name = EXCLUDED.name,
               sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
        [upsertScenes.map(s => s.id), versionId,
         upsertScenes.map(s => s.number), upsertScenes.map(s => s.name), upsertScenes.map(s => s.sortOrder),
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
          `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7::block_type, $8, $9, $10::jsonb, $11)`,
          [snapshotId, block.id, productionId, block.lexKey,
           block.sceneId ?? null, block.rehearsalMark ?? null, toDbType(block), block.content,
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
            `UPDATE script SET scene_id = $1, rehearsal_mark = $2, type = $3::block_type, content = $4, stage_comment = $5, marker_meta = $6::jsonb, force_show_character_name = $7 WHERE id = $8`,
            [block.sceneId ?? null, block.rehearsalMark ?? null, toDbType(block), block.content,
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
            `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7::block_type, $8, $9, $10::jsonb, $11)`,
            [newSnapshotId, block.id, productionId, block.lexKey,
             block.sceneId ?? null, block.rehearsalMark ?? null, toDbType(block), block.content,
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

    // Deletes: remove from version relation; garbage-collect orphan snapshots
    if (deleteSnapshotIds.length > 0) {
      await client.query(
        `WITH removed AS (
           DELETE FROM script_version WHERE snapshot_id = ANY($1::text[]) AND version_id = $2 RETURNING snapshot_id
         )
         DELETE FROM script s
         WHERE s.id IN (SELECT snapshot_id FROM removed)
           AND NOT EXISTS (SELECT 1 FROM script_version sv2 WHERE sv2.snapshot_id = s.id)`,
        [deleteSnapshotIds, versionId]
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
  const { upsertBlocks, deleteBlockIds, upsertChars, deleteCharIds, upsertScenes, deleteSceneIds } = payload;
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

    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertScenes.map(s => s.id), productionId]
      );
      if (versionId) {
        await client.query(
          `INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id)
           SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]), unnest($5::int[]), unnest($6::text[])
           ON CONFLICT (scene_id, version_id) DO UPDATE
             SET num = EXCLUDED.num, name = EXCLUDED.name,
                 sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
          [upsertScenes.map(s => s.id), versionId,
           upsertScenes.map(s => s.number), upsertScenes.map(s => s.name), upsertScenes.map(s => s.sortOrder),
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
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
         SELECT unnest($1::text[]), unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]),
                unnest($5::text[]), unnest($6::block_type[]), unnest($7::text[]), unnest($8::text[]),
                unnest($9::jsonb[]), unnest($10::bool[])
         ON CONFLICT (id) DO UPDATE SET
           block_id = EXCLUDED.block_id, sort_key = EXCLUDED.sort_key, scene_id = EXCLUDED.scene_id,
           rehearsal_mark = EXCLUDED.rehearsal_mark, type = EXCLUDED.type, content = EXCLUDED.content,
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
      sceneId: string | null;
      rehearsalMark: string | null;
      markerMeta?: MarkerMeta | null;
      lexKey: string;
    }>;
    upsertChars: Array<{ id: string; name: string; isAggregate: boolean; sortOrder: number }>;
    upsertScenes: Array<{ id: string; number: string; name: string; parentId: string | null; sortOrder: number }>;
    deleteSceneIds?: string[];
  },
): Promise<void> {
  const { upsertBlocks, upsertChars, upsertScenes, deleteSceneIds = [] } = payload;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Clear all blocks from this version; GC snapshots no longer referenced by any version
    await client.query(
      `WITH removed AS (
         DELETE FROM script_version WHERE version_id = $1 RETURNING snapshot_id, block_id
       ),
       deleted_orphan_tags AS (
         DELETE FROM block_tag bt
         WHERE bt.block_id IN (SELECT block_id FROM removed)
           AND NOT EXISTS (SELECT 1 FROM script_version sv WHERE sv.block_id = bt.block_id)
         RETURNING 1
       )
       DELETE FROM script s
       WHERE s.id IN (SELECT snapshot_id FROM removed)
         AND NOT EXISTS (SELECT 1 FROM script_version sv2 WHERE sv2.snapshot_id = s.id)`,
      [versionId]
    );

    // Import is a full replacement of script + dramaturgy for this version.
    // scene_version is only a compatibility cache; rebuild it from markers below.
    await client.query("DELETE FROM scene_version WHERE version_id = $1", [versionId]);

    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id)
         SELECT unnest($1::text[]), $2::text
         ON CONFLICT (id) DO NOTHING`,
        [upsertScenes.map(s => s.id), productionId]
      );
      await client.query(
        `INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]), unnest($5::int[]), unnest($6::text[])
         ON CONFLICT (scene_id, version_id) DO UPDATE
           SET num = EXCLUDED.num, name = EXCLUDED.name,
               sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
        [upsertScenes.map(s => s.id), versionId,
         upsertScenes.map(s => s.number), upsertScenes.map(s => s.name),
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
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, force_show_character_name, marker_meta)
         SELECT unnest($1::text[]), unnest($10::text[]), $2::text, unnest($3::text[]),
                unnest($4::text[]), unnest($5::text[]), unnest($6::block_type[]), unnest($7::text[]),
                unnest($8::text[]), unnest($9::bool[]), unnest($11::jsonb[])`,
        [
          upsertBlocks.map(b => b.id), productionId,
          upsertBlocks.map(b => b.lexKey), upsertBlocks.map(b => b.sceneId ?? null),
          upsertBlocks.map(b => b.rehearsalMark ?? null),
          upsertBlocks.map(b => toDbType(b as Block)),
          upsertBlocks.map(b => b.content),
          upsertBlocks.map(b => b.stageComment?.trim() || null),
          upsertBlocks.map(() => false),
          upsertBlocks.map(b => b.blockId ?? b.id),
          upsertBlocks.map(b => JSON.stringify(cleanMarkerMeta(b.markerMeta))),
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

    await syncSceneVersionsFromMarkersInTx(client, productionId, versionId);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Production management ────────────────────────────────────────────────────

export async function createProduction(id: string, name: string): Promise<void> {
  await getPool().query("INSERT INTO production (id, name) VALUES ($1, $2)", [id, name]);
  await createInitialVersion(id);
}

export async function deleteProduction(id: string): Promise<void> {
  await getPool().query("DELETE FROM production WHERE id = $1", [id]);
}

export async function listProductions(opts: { openId: string; isAdmin: boolean }): Promise<{ id: string; name: string; createdAt: string; archivedAt: string | null; sortOrder: number }[]> {
  const orderBy = "CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, sort_order ASC, created_at ASC";
  let res;
  if (opts.isAdmin) {
    res = await getPool().query<{ id: string; name: string; created_at: Date; archived_at: Date | null; sort_order: number }>(
      `SELECT id, name, created_at, archived_at, sort_order FROM production ORDER BY ${orderBy}`
    );
  } else {
    res = await getPool().query<{ id: string; name: string; created_at: Date; archived_at: Date | null; sort_order: number }>(
      `SELECT p.id, p.name, p.created_at, p.archived_at, p.sort_order FROM production p
       JOIN production_member pm ON pm.production_id = p.id
       WHERE pm.open_id = $1 ORDER BY ${orderBy}`,
      [opts.openId]
    );
  }
  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
    sortOrder: r.sort_order,
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

export type UserInfo = { openId: string; name: string; avatarUrl: string | null; isAdmin: boolean };

export async function upsertFeishuUser(openId: string, name: string, avatarUrl: string | null, isAdmin: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO feishu_user (open_id, name, avatar_url, is_super_admin, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (open_id) DO UPDATE
       SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, is_super_admin = EXCLUDED.is_super_admin, updated_at = now()`,
    [openId, name, avatarUrl, isAdmin]
  );
}

export async function getFeishuUser(openId: string): Promise<UserInfo | null> {
  const res = await getPool().query<{ open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    "SELECT open_id, name, avatar_url, is_super_admin FROM feishu_user WHERE open_id = $1",
    [openId]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { openId: r.open_id, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin };
}

export async function listAllUsers(): Promise<UserInfo[]> {
  const res = await getPool().query<{ open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    "SELECT open_id, name, avatar_url, is_super_admin FROM feishu_user ORDER BY name"
  );
  return res.rows.map(r => ({ openId: r.open_id, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin }));
}

export async function canUserAccessProduction(openId: string, productionId: string): Promise<boolean> {
  const res = await getPool().query<{ count: string }>(
    "SELECT count(*)::text FROM production_member WHERE open_id = $1 AND production_id = $2",
    [openId, productionId]
  );
  return parseInt(res.rows[0].count) > 0;
}

/** Returns the user's roles in the production, or null if they are not a member. */
export async function getProductionMemberRoles(
  openId: string,
  productionId: string,
): Promise<string[] | null> {
  const res = await getPool().query<{ roles: string[] }>(
    "SELECT roles FROM production_member WHERE open_id = $1 AND production_id = $2",
    [openId, productionId],
  );
  return res.rows.length ? res.rows[0].roles : null;
}

export async function getPermissionOverrides(
  productionId: string,
  openId: string,
): Promise<PermissionOverrides> {
  const res = await getPool().query<{ permission: string; granted: boolean }>(
    "SELECT permission, granted FROM production_member_permission WHERE production_id = $1 AND open_id = $2",
    [productionId, openId],
  );
  const map: PermissionOverrides = new Map();
  for (const row of res.rows) map.set(row.permission as Permission, row.granted);
  return map;
}

export async function setPermissionOverride(
  productionId: string,
  openId: string,
  permission: Permission,
  granted: boolean | null,
): Promise<void> {
  if (granted === null) {
    await getPool().query(
      "DELETE FROM production_member_permission WHERE production_id = $1 AND open_id = $2 AND permission = $3",
      [productionId, openId, permission],
    );
  } else {
    await getPool().query(
      `INSERT INTO production_member_permission (production_id, open_id, permission, granted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (production_id, open_id, permission) DO UPDATE SET granted = EXCLUDED.granted`,
      [productionId, openId, permission, granted],
    );
  }
}

/** Bulk-load all overrides for all members in a production (for the management UI). */
export async function getAllPermissionOverrides(
  productionId: string,
): Promise<Record<string, Record<string, boolean>>> {
  const res = await getPool().query<{ open_id: string; permission: string; granted: boolean }>(
    "SELECT open_id, permission, granted FROM production_member_permission WHERE production_id = $1",
    [productionId],
  );
  const result: Record<string, Record<string, boolean>> = {};
  for (const row of res.rows) {
    result[row.open_id] ??= {};
    result[row.open_id][row.permission] = row.granted;
  }
  return result;
}

/** Fetch roles + overrides + archived status for a single user in parallel. */
export async function getProductionMemberContext(
  openId: string,
  isAdmin: boolean,
  productionId: string,
): Promise<{ memberRoles: string[] | null; overrides: PermissionOverrides; isArchived: boolean }> {
  const [memberRoles, overrides, archivedRow] = await Promise.all([
    getProductionMemberRoles(openId, productionId),
    getPermissionOverrides(productionId, openId),
    getPool().query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM production WHERE id = $1",
      [productionId],
    ),
  ]);
  void isAdmin;
  return { memberRoles, overrides, isArchived: archivedRow.rows[0]?.archived_at != null };
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

export async function listProductionMembers(productionId: string): Promise<UserInfo[]> {
  const res = await getPool().query<{ open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    `SELECT fu.open_id, fu.name, fu.avatar_url, fu.is_super_admin
     FROM production_member pm JOIN feishu_user fu ON fu.open_id = pm.open_id
     WHERE pm.production_id = $1 ORDER BY fu.name`,
    [productionId]
  );
  return res.rows.map(r => ({ openId: r.open_id, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin }));
}

export async function addProductionMember(productionId: string, openId: string): Promise<void> {
  await getPool().query(
    "INSERT INTO production_member (production_id, open_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [productionId, openId]
  );
}

export async function removeProductionMember(productionId: string, openId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM production_member WHERE production_id = $1 AND open_id = $2",
    [productionId, openId]
  );
}

export async function searchFeishuUsers(query: string): Promise<{
  openId: string; name: string; avatarUrl: string | null;
  email: string | null; phone: string | null; hint: string | null;
}[]> {
  const res = await getPool().query<{
    open_id: string; name: string; avatar_url: string | null; email: string | null; phone: string | null;
  }>(
    `SELECT open_id, name, avatar_url, email, phone FROM feishu_user
     WHERE name ILIKE $1
     ORDER BY name LIMIT 20`,
    [`%${query}%`]
  );
  return res.rows.map((r) => ({
    openId: r.open_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    email: r.email,
    phone: r.phone,
    hint: r.email ?? (r.phone && r.phone.length >= 4
      ? r.phone.replace(/(\d{3})\d+(\d{4})/, "$1****$2")
      : r.phone),
  }));
}

export async function setMemberRoles(
  productionId: string,
  openId: string,
  roles: string[]
): Promise<void> {
  await getPool().query(
    "UPDATE production_member SET roles = $3 WHERE production_id = $1 AND open_id = $2",
    [productionId, openId, roles]
  );
}

export async function updateUserContact(
  openId: string,
  email: string | null,
  phone: string | null
): Promise<void> {
  await getPool().query(
    `UPDATE feishu_user
     SET email = COALESCE($2, email),
         phone = COALESCE($3, phone),
         updated_at = now()
     WHERE open_id = $1`,
    [openId, email, phone]
  );
}

export async function setMemberPhoto(
  productionId: string,
  openId: string,
  photoUrl: string | null
): Promise<void> {
  await getPool().query(
    "UPDATE production_member SET photo_url = $3 WHERE production_id = $1 AND open_id = $2",
    [productionId, openId, photoUrl]
  );
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export type Mention = { openId: string; name: string };

export type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  openId: string;
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
  open_id: string;
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
    openId: r.open_id,
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
            open_id, author_name, body, mentions, created_at, updated_at
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
  openId: string,
  authorName: string,
  body: string,
  mentions: Mention[],
): Promise<Comment> {
  const res = await getPool().query<CommentRow>(
    `INSERT INTO comment
       (production_id, context_type, context_id, parent_id, open_id, author_name, body, mentions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, production_id, context_type, context_id, parent_id,
               open_id, author_name, body, mentions, created_at, updated_at`,
    [productionId, contextType, contextId, parentId, openId, authorName, body, JSON.stringify(mentions)]
  );
  return rowToComment(res.rows[0]);
}

export async function getCommentById(id: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `SELECT id, production_id, context_type, context_id, parent_id,
            open_id, author_name, body, mentions, created_at, updated_at
     FROM comment WHERE id = $1`,
    [id]
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function updateComment(id: string, openId: string, body: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `UPDATE comment SET body = $1, updated_at = now()
     WHERE id = $2 AND open_id = $3
     RETURNING id, production_id, context_type, context_id, parent_id,
               open_id, author_name, body, mentions, created_at, updated_at`,
    [body, id, openId]
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function deleteComment(id: string, openId: string, isAdmin: boolean): Promise<boolean> {
  const res = isAdmin
    ? await getPool().query("DELETE FROM comment WHERE id = $1 RETURNING id", [id])
    : await getPool().query("DELETE FROM comment WHERE id = $1 AND open_id = $2 RETURNING id", [id, openId]);
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

export async function updateProductionName(id: string, name: string): Promise<void> {
  await getPool().query("UPDATE production SET name = $1 WHERE id = $2", [name, id]);
}

export type MemberWithRoles = {
  openId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  email: string | null;
  phone: string | null;
  roles: string[];
  photoUrl: string | null;
};

export async function listProductionMembersWithRoles(productionId: string): Promise<MemberWithRoles[]> {
  const res = await getPool().query<{
    open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean;
    email: string | null; phone: string | null; roles: string[]; photo_url: string | null;
  }>(
    `SELECT fu.open_id, fu.name, fu.avatar_url, fu.is_super_admin,
            fu.email, fu.phone, pm.roles, pm.photo_url
     FROM production_member pm
     JOIN feishu_user fu ON fu.open_id = pm.open_id
     WHERE pm.production_id = $1
     ORDER BY fu.name`,
    [productionId]
  );
  return res.rows.map((r) => ({
    openId: r.open_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    isAdmin: r.is_super_admin,
    email: r.email,
    phone: r.phone,
    roles: r.roles,
    photoUrl: r.photo_url,
  }));
}

/** Returns open IDs of all 制作人 and 制作助理 in a production (auto-added to dept chats). */
export async function getBossOpenIds(productionId: string): Promise<string[]> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT open_id FROM production_member
     WHERE production_id = $1
       AND ('制作人' = ANY(roles) OR '制作助理' = ANY(roles))`,
    [productionId]
  );
  return res.rows.map(r => r.open_id);
}

// ─── Contact import ───────────────────────────────────────────────────────────

export async function findUserByName(name: string): Promise<{ openId: string } | null> {
  const res = await getPool().query<{ open_id: string }>(
    "SELECT open_id FROM feishu_user WHERE name = $1 LIMIT 1",
    [name]
  );
  return res.rows[0] ? { openId: res.rows[0].open_id } : null;
}

// Writes a user sourced from the contact sheet. Email/phone only overwrite if non-null.
export async function upsertContactUser(
  openId: string,
  name: string,
  avatarUrl: string | null,
  email: string | null,
  phone: string | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO feishu_user (open_id, name, avatar_url, email, phone, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (open_id) DO UPDATE
       SET name       = EXCLUDED.name,
           avatar_url = COALESCE(EXCLUDED.avatar_url, feishu_user.avatar_url),
           email      = COALESCE(EXCLUDED.email,      feishu_user.email),
           phone      = COALESCE(EXCLUDED.phone,      feishu_user.phone),
           updated_at = now()`,
    [openId, name, avatarUrl, email, phone]
  );
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

/** Returns ordered rehearsal marks grouped by scene_id. */
export async function listRehearsalMarksByScene(productionId: string): Promise<Record<string, string[]>> {
  const res = await getPool().query<{ scene_id: string | null; rehearsal_mark: string | null; type: string }>(
    `SELECT scene_id, rehearsal_mark, type::text AS type
     FROM script
     WHERE production_id = $1
     ORDER BY sort_key`,
    [productionId]
  );
  return generatedRehearsalMarksByScene(res.rows.map((row) => ({
    sceneId: row.scene_id,
    rehearsalMark: row.rehearsal_mark,
    type: row.type,
  })));
}

export async function listScenesByVersion(versionId: string): Promise<SceneDetail[]> {
  const res = await getPool().query<{
    id: string; num: string; name: string; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: string | null;
  }>(
    `${VERSION_SCENES_FROM_MARKERS_CTE}
     SELECT ms.id,
            COALESCE(ms.marker_meta->>'number', '') AS num,
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
  );
  return withGeneratedSceneNumbers(res.rows.map((r) => ({
    id: r.id, number: r.num, name: r.name, parentId: r.parent_id,
    synopsis: r.synopsis ?? "",
    actionLine: r.action_line ?? "",
    music: r.music ?? "",
    stageNotes: r.stage_notes ?? "",
    expectedDuration: r.expected_duration ?? "",
  })));
}

export async function listSceneVersionsByVersion(versionId: string): Promise<SceneDetail[]> {
  const res = await getPool().query<{
    id: string; num: string; name: string; sort_order: number; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: string | null;
  }>(
    `SELECT scene_id AS id, num, name, sort_order, parent_id,
            synopsis, action_line, music, stage_notes, expected_duration
     FROM scene_version
     WHERE version_id = $1
     ORDER BY sort_order, scene_id`,
    [versionId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    number: r.num,
    name: r.name,
    parentId: r.parent_id,
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

export async function listProductionScenes(productionId: string): Promise<SceneDetail[]> {
  console.error(`[fallback] listProductionScenes called without versionId for production ${productionId} — caller should use listScenesByVersion directly`);
  const versionId = await getActiveVersionId(productionId);
  if (!versionId) return [];
  return listScenesByVersion(versionId);
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
    if (markerRes.rows.length === 0) {
      const markerCountRes = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt
         FROM script_version sv
         JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1
           AND sv.block_id <> $2
           AND s.type IN ('chapter_marker', 'scene_marker')`,
        [versionId, FIXED_INITIAL_CHAPTER_BLOCK_ID]
      );
      const markerCount = parseInt(markerCountRes.rows[0]?.cnt ?? "0", 10);
      if (markerCount > 0) {
        throw new Error(`Expected exactly one marker block for scene ${sceneId} in version ${versionId}, found ${markerRes.rows.length}`);
      }
      const stagedRes = await client.query<{ production_id: string }>(
        `UPDATE scene_version sv
         SET synopsis = COALESCE($3, synopsis),
             action_line = COALESCE($4, action_line),
             music = COALESCE($5, music),
             stage_notes = COALESCE($6, stage_notes),
             expected_duration = COALESCE($7, expected_duration)
         FROM version v
         WHERE sv.version_id = $1
           AND sv.scene_id = $2
           AND v.id = sv.version_id
         RETURNING v.production_id`,
        [
          versionId,
          sceneId,
          fields.synopsis ?? null,
          fields.actionLine ?? null,
          fields.music ?? null,
          fields.stageNotes ?? null,
          fields.expectedDuration ?? null,
        ]
      );
      if (stagedRes.rows[0]?.production_id !== productionId) {
        throw new Error("Scene metadata row does not belong to production");
      }
      await client.query("COMMIT");
      return;
    }
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
        `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
         SELECT $1, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment,
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

type CueListRow = {
  id: string; production_id: string; name: string; notes: string;
  abbr: string | null; template: string | null; default_edit_roles: string[];
  created_by: string; created_by_name: string; created_at: Date;
};

function rowToCueList(r: CueListRow): CueList {
  return {
    id: r.id, productionId: r.production_id, name: r.name, notes: r.notes,
    abbr: r.abbr, template: r.template, defaultEditRoles: r.default_edit_roles,
    createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listCueLists(productionId: string): Promise<CueList[]> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.default_edit_roles, cl.created_by, fu.name AS created_by_name, cl.created_at
     FROM cue_list cl
     JOIN feishu_user fu ON fu.open_id = cl.created_by
     WHERE cl.production_id = $1
     ORDER BY cl.created_at`,
    [productionId]
  );
  return res.rows.map(rowToCueList);
}

export async function createCueList(data: {
  id: string; productionId: string; name: string; notes: string;
  abbr: string | null; template: string | null; defaultEditRoles: string[]; createdBy: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO cue_list (id, production_id, name, notes, abbr, template, default_edit_roles, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [data.id, data.productionId, data.name, data.notes, data.abbr, data.template, data.defaultEditRoles, data.createdBy]
  );
}

export async function getCueList(id: string, productionId: string): Promise<CueList | null> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.default_edit_roles, cl.created_by, fu.name AS created_by_name, cl.created_at
     FROM cue_list cl
     JOIN feishu_user fu ON fu.open_id = cl.created_by
     WHERE cl.id = $1 AND cl.production_id = $2`,
    [id, productionId]
  );
  if (!res.rows.length) return null;
  return rowToCueList(res.rows[0]);
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
  const res = await getPool().query<{ open_id: string; can_edit: boolean }>(
    "SELECT open_id, can_edit FROM cue_list_permission WHERE cue_list_id = $1",
    [cueListId]
  );
  return res.rows.map(r => ({ openId: r.open_id, canEdit: r.can_edit }));
}

export async function setCueListPermission(
  cueListId: string, openId: string, canEdit: boolean | null
): Promise<void> {
  if (canEdit === null) {
    await getPool().query(
      "DELETE FROM cue_list_permission WHERE cue_list_id = $1 AND open_id = $2",
      [cueListId, openId]
    );
  } else {
    await getPool().query(
      `INSERT INTO cue_list_permission (cue_list_id, open_id, can_edit) VALUES ($1, $2, $3)
       ON CONFLICT (cue_list_id, open_id) DO UPDATE SET can_edit = EXCLUDED.can_edit`,
      [cueListId, openId, canEdit]
    );
  }
}

// ─── Cues ─────────────────────────────────────────────────────────────────────

// After migration: start_block_id/end_block_id are renamed to start_snapshot_id/end_snapshot_id.
// The row also has start_block_id/end_block_id as computed aliases from the JOIN with script table.
type CueRow = {
  id: string; cue_list_id: string; number: string; name: string; content: string;
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
  return { id: r.id, cueListId: r.cue_list_id, number: r.number, name: r.name, content: r.content, start, end, warning: r.warning };
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
  SELECT c.id, c.cue_list_id, c.number, c.name, c.content,
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

  // Pre-check: if renaming, ensure the new number won't conflict in any descendant
  // version that would be cascade-updated by CoW.
  if (fields.number !== undefined) {
    const conflictRes = await getPool().query<{ version_id: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM version WHERE id = $1
         UNION ALL
         SELECT v.id FROM version v
         INNER JOIN descendants d ON v.parent_version_id = d.id
       ),
       cascade_targets AS (
         SELECT version_id FROM cue_version
         WHERE revision_id = $2
           AND version_id IN (SELECT id FROM descendants)
       )
       SELECT cv.version_id
       FROM cue_version cv
       JOIN cue c ON c.id = cv.revision_id
       WHERE cv.version_id IN (SELECT version_id FROM cascade_targets)
         AND c.cue_list_id = $3
         AND c.number = $4
         AND (c.cue_id IS DISTINCT FROM (SELECT cue_id FROM cue WHERE id = $2)
              AND c.id != $2)
       LIMIT 1`,
      [versionId, id, cueListId, fields.number]
    );
    if (conflictRes.rows.length > 0) {
      throw new Error(`CUE_NUMBER_CONFLICT:${conflictRes.rows[0].version_id}`);
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const refRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [id]
    );
    const refCount = parseInt(refRes.rows[0].count, 10);

    if (refCount <= 1) {
      const { sets, vals } = buildInPlaceUpdate();
      if (sets.length) await client.query(`UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`, vals);
    } else {
      // CoW: fork a new physical row for versionId and its descendants
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

      // Remap cue_version for versionId + all descendants still pointing to old revision
      await client.query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM version WHERE id = $1
           UNION ALL
           SELECT v.id FROM version v
           INNER JOIN descendants d ON v.parent_version_id = d.id
         )
         UPDATE cue_version SET revision_id = $2
         WHERE revision_id = $3
           AND version_id IN (SELECT id FROM descendants)`,
        [versionId, newId, id]
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
    // Remove cue_version for versionId and all its descendants
    await client.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM version WHERE id = $1
         UNION ALL
         SELECT v.id FROM version v
         INNER JOIN descendants d ON v.parent_version_id = d.id
       )
       DELETE FROM cue_version
       WHERE revision_id = $2
         AND version_id IN (SELECT id FROM descendants)`,
      [versionId, id]
    );
    // Delete the physical row only if no version references it anymore
    const refRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [id]
    );
    if (parseInt(refRes.rows[0].count, 10) === 0) {
      await client.query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
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
 *  then remap cue_version for `versionId` and its descendants from old to new id.
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
    `WITH RECURSIVE descendants AS (
       SELECT id FROM version WHERE id = $1
       UNION ALL
       SELECT v.id FROM version v
       INNER JOIN descendants d ON v.parent_version_id = d.id
     )
     UPDATE cue_version SET revision_id = $2
     WHERE revision_id = $3
       AND version_id IN (SELECT id FROM descendants)`,
    [versionId, newId, cur.id]
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
  } else {
    await client.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM version WHERE id = $1
         UNION ALL
         SELECT v.id FROM version v
         INNER JOIN descendants d ON v.parent_version_id = d.id
       )
       DELETE FROM cue_version
       WHERE revision_id = $2
         AND version_id IN (SELECT id FROM descendants)`,
      [versionId, revisionId]
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
  openId: string,
  roles: string[],
  photoUrl: string | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member (production_id, open_id, roles, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (production_id, open_id) DO UPDATE
       SET roles     = EXCLUDED.roles,
           photo_url = EXCLUDED.photo_url`,
    [productionId, openId, roles, photoUrl]
  );
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

const DESCENDANTS_CTE = `
  WITH RECURSIVE descendants AS (
    SELECT id FROM version WHERE id = $1
    UNION ALL
    SELECT v.id FROM version v
    JOIN descendants d ON v.parent_version_id = d.id
  )`;

/**
 * Copy-on-write a block snapshot for an asset mount operation.
 * tracking:     new snapshot covers current version + all descendants
 * version_only: new snapshot covers current version only
 * Returns the snapshot ID the mount should be created against.
 */
export async function cowBlockSnapshotForMount(
  versionId: string,
  snapshotId: string,
  mode: 'tracking' | 'version_only',
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
      `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
       SELECT $1, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name
       FROM script WHERE id = $2`,
      [newSnapshotId, snapshotId]
    );
    await client.query(
      `INSERT INTO script_character (script_id, character_id, position, annotation)
       SELECT $1, character_id, position, annotation FROM script_character WHERE script_id = $2`,
      [newSnapshotId, snapshotId]
    );
    // block_tag rows are keyed by logical block_id, not snapshot_id — no copy needed.

    if (mode === 'tracking') {
      await client.query(
        `${DESCENDANTS_CTE}
         UPDATE script_version SET snapshot_id = $2
         WHERE snapshot_id = $3 AND version_id IN (SELECT id FROM descendants)`,
        [versionId, newSnapshotId, snapshotId]
      );
    } else {
      await client.query(
        'UPDATE script_version SET snapshot_id = $1 WHERE snapshot_id = $2 AND version_id = $3',
        [newSnapshotId, snapshotId, versionId]
      );
    }

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
 * tracking:     new revision covers current version + all descendants
 * version_only: new revision covers current version only
 * Returns the revision ID the mount should be created against.
 */
export async function cowCueRevisionForMount(
  versionId: string,
  revisionId: string,
  mode: 'tracking' | 'version_only',
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

    if (mode === 'tracking') {
      await client.query(
        `${DESCENDANTS_CTE}
         UPDATE cue_version SET revision_id = $2
         WHERE revision_id = $3 AND version_id IN (SELECT id FROM descendants)`,
        [versionId, newId, revisionId]
      );
    } else {
      await client.query(
        'UPDATE cue_version SET revision_id = $1 WHERE revision_id = $2 AND version_id = $3',
        [newId, revisionId, versionId]
      );
    }

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
export async function listMemberProductions(openId: string): Promise<{ id: string; name: string; archivedAt: string | null }[]> {
  const res = await getPool().query<{ id: string; name: string; archived_at: Date | null }>(
    `SELECT p.id, p.name, p.archived_at
     FROM production p
     JOIN production_member pm ON pm.production_id = p.id
     WHERE pm.open_id = $1
     ORDER BY CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END, p.sort_order ASC, p.created_at ASC`,
    [openId],
  );
  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    archivedAt: r.archived_at?.toISOString() ?? null,
  }));
}

// ─── Atomic patch application ─────────────────────────────────────────────────

const ALL_PATCH_LAYOUTS: PageLayout[] = ["a4", "letter", "a3-2col", "tablet-2col"];

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
  type TxBlock = { blockId: string; snapshotId: string; lexKey: string; type: string };
  type TxScene = Scene & { sortOrder: number };
  type TxChar  = Character & { sortOrder: number };

  // Collected inside the transaction; consumed post-commit for cue drift
  const driftDeletes: Array<{ snapshotId: string; prevId: string | null; nextId: string | null }> = [];
  const driftUpdates: Array<{ oldSnapshotId: string; newSnapshotId: string; oldContent: string; newContent: string }> = [];

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
    const blockRows = await client.query<{ block_id: string; snapshot_id: string; sort_key: string; type: string }>(
      `SELECT sv.block_id, sv.snapshot_id, sv.sort_key, s.type::text AS type
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
       ORDER BY sv.sort_key`,
      [versionId]
    );
    const sceneRows = await client.query<{ scene_id: string; num: string; name: string; sort_order: number; parent_id: string | null }>(
      "SELECT sv.scene_id, sv.num, sv.name, sv.sort_order, sv.parent_id FROM scene_version sv WHERE sv.version_id = $1 ORDER BY sv.sort_order",
      [versionId]
    );
    const charRows = await client.query<{ character_id: string; name: string; sort_order: number; is_aggregate: boolean }>(
      "SELECT cv.character_id, cv.name, cv.sort_order, cv.is_aggregate FROM character_version cv WHERE cv.version_id = $1 ORDER BY cv.sort_order",
      [versionId]
    );

    // Working ordered block list (mutated as ops are applied)
    const txBlocks: TxBlock[] = blockRows.rows.map(r => ({
      blockId: r.block_id, snapshotId: r.snapshot_id, lexKey: r.sort_key, type: r.type,
    }));
    const txBlockMap = new Map<string, TxBlock>(txBlocks.map(b => [b.blockId, b]));
    let shouldSyncSceneVersions = patch.sceneOps.length > 0;

    // Working scene / char lists
    const txScenes: TxScene[] = sceneRows.rows.map(r => ({
      id: r.scene_id, number: r.num, name: r.name, parentId: r.parent_id, sortOrder: r.sort_order,
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
        if (idx >= 0) txScenes.splice(idx, 1);
        deletedSceneIds.add(op.id);
        dirtySceneIds.delete(op.id);
      } else { // reorder
        const sceneMap = new Map(txScenes.map(s => [s.id, s]));
        const newOrder = op.ids.map(id => sceneMap.get(id)).filter((s): s is TxScene => !!s);
        for (let i = 0; i < newOrder.length; i++) {
          if (newOrder[i].sortOrder !== i) {
            newOrder[i] = { ...newOrder[i], sortOrder: i };
            dirtySceneIds.add(newOrder[i].id);
          }
        }
        txScenes.length = 0;
        txScenes.push(...newOrder);
      }
    }

    if (deletedSceneIds.size > 0) {
      await client.query(
        "DELETE FROM scene_version WHERE scene_id = ANY($1::text[]) AND version_id = $2",
        [[...deletedSceneIds], versionId]
      );
    }
    if (dirtySceneIds.size > 0) {
      const toWrite = txScenes.filter(s => dirtySceneIds.has(s.id));
      await client.query(
        `INSERT INTO scene (id, production_id) SELECT unnest($1::text[]), $2 ON CONFLICT (id) DO NOTHING`,
        [toWrite.map(s => s.id), productionId]
      );
      await client.query(
        `INSERT INTO scene_version (scene_id, version_id, num, name, sort_order, parent_id)
         SELECT unnest($1::text[]), $2, unnest($3::text[]), unnest($4::text[]), unnest($5::int[]), unnest($6::text[])
         ON CONFLICT (scene_id, version_id) DO UPDATE
           SET num = EXCLUDED.num, name = EXCLUDED.name,
               sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
        [toWrite.map(s => s.id), versionId,
         toWrite.map(s => s.number), toWrite.map(s => s.name),
         toWrite.map(s => s.sortOrder), toWrite.map(s => s.parentId ?? null)]
      );
    }
    if (dirtySceneIds.size > 0 || deletedSceneIds.size > 0) {
      await normalizeSceneOwnershipOrderInTx(client, versionId);
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

          await client.query(
            `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7::block_type, $8, $9, $10::jsonb, $11)`,
            [snapshotId, insertBlock.id, productionId, lexKey,
             insertBlock.sceneId ?? null, insertBlock.rehearsalMark ?? null,
             toDbType(insertBlock), insertBlock.content,
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

          if (isChapterSceneMarkerType(toDbType(insertBlock))) shouldSyncSceneVersions = true;

          const newTxBlock: TxBlock = { blockId: op.block.id, snapshotId, lexKey, type: toDbType(insertBlock) };
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
          if (isChapterSceneMarkerType(cur.type) || isChapterSceneMarkerType(nextType)) {
            shouldSyncSceneVersions = true;
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
              [updateBlock.sceneId ?? null, updateBlock.rehearsalMark ?? null,
               nextType, updateBlock.content,
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
              `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, type, content, stage_comment, marker_meta, force_show_character_name)
               VALUES ($1, $2, $3, $4, $5, $6, $7::block_type, $8, $9, $10::jsonb, $11)`,
              [newSnapshotId, updateBlock.id, productionId, cur.lexKey,
               updateBlock.sceneId ?? null, updateBlock.rehearsalMark ?? null,
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

          break;
        }

        case 'delete': {
          const cur = txBlockMap.get(op.id);
          if (!cur) break; // already gone — skip silently
          if (isChapterSceneMarkerType(cur.type)) shouldSyncSceneVersions = true;

          // Remove from version; GC orphan snapshot if no other version references it
          await client.query(
            `WITH removed AS (
               DELETE FROM script_version WHERE snapshot_id = $1 AND version_id = $2 RETURNING snapshot_id
             )
             DELETE FROM script s
             WHERE s.id IN (SELECT snapshot_id FROM removed)
               AND NOT EXISTS (SELECT 1 FROM script_version sv2 WHERE sv2.snapshot_id = s.id)`,
            [cur.snapshotId, versionId]
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

          const idx = txBlocks.findIndex(b => b.blockId === op.id);
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
          const oldMarkerOrder = txBlocks
            .filter((block) => isChapterSceneMarkerType(block.type))
            .map((block) => block.blockId)
            .join(",");
          const nextMarkerOrder = ordered
            .filter((block) => isChapterSceneMarkerType(block.type))
            .map((block) => block.blockId)
            .join(",");
          if (oldMarkerOrder !== nextMarkerOrder) shouldSyncSceneVersions = true;

          // Assign fresh evenly-distributed keys; update only the rows that changed.
          const newKeys = initialKeys(ordered.length);
          for (let i = 0; i < ordered.length; i++) {
            if (ordered[i].lexKey !== newKeys[i]) {
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

    if (shouldSyncSceneVersions) {
      await syncSceneVersionsFromMarkersInTx(client, productionId, versionId);
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

  // ── Post-commit: update page map (fire-and-forget) ────────────────────────
  loadProduction(productionId, versionId)
    .then(result => {
      if (!result) return;
      return savePageMap(
        productionId,
        Object.fromEntries(
          ALL_PATCH_LAYOUTS.map(layout => [layout, computePageMap(result.state.blocks, layout)])
        ),
      );
    })
    .catch(err => console.error("[page-map] update error:", err));
}
