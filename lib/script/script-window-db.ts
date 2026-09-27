import { getPool } from "../pg";
import { buildMarkerLabelIndex } from "./script-generated-labels";
import { loadVersionBlockRange } from "./script-block-read-db";
import { getBlockTagsByIds, listTagGroups } from "./script-block-tag-db";
import { getScriptConfig } from "./script-state-db";
import { getEstimatedPageMap } from "./page-map-db";
import { VERSION_SCENES_FROM_MARKERS_CTE } from "./script-marker-sql";
import { cleanMarkerMeta, fromDbType, isChapterSceneMarkerType, isMarkerBlockType, type CharRow, type DbBlockType, type SceneRow } from "./script-row-model";
import type { Block } from "./script-types";
import type { ScriptBlockManifestEntry, ScriptWindowBootstrap, ScriptWindowResponse } from "./script-window-types";

type ManifestRow = {
  block_id: string;
  scene_id: string | null;
  rehearsal_mark: string | null;
  owner_marker_id: string | null;
  marker_meta: Block["markerMeta"];
  type: DbBlockType;
};

const MANIFEST_SQL = `SELECT sv.block_id, s.scene_id, s.rehearsal_mark,
        s.owner_marker_id, s.marker_meta, s.type
   FROM script_version sv
   JOIN script s ON s.id = sv.snapshot_id
  WHERE sv.version_id = $1
  ORDER BY sv.sort_key`;

type OrderMetaRow = { total_count: string; revision: string };
const ORDER_META_SQL = `SELECT count(sv.block_id)::text AS total_count,
        md5(COALESCE(string_agg(sv.block_id, E'\\x1f' ORDER BY sv.sort_key), '')) AS revision
   FROM version v
   LEFT JOIN script_version sv ON sv.version_id = v.id
  WHERE v.id = $1 AND v.production_id = $2
  GROUP BY v.id`;

function manifestEntry(row: ManifestRow): ScriptBlockManifestEntry {
  const { type, lyric } = fromDbType(row.type);
  return {
    id: row.block_id,
    type,
    lyric,
    sceneId: isChapterSceneMarkerType(row.type) ? row.block_id : row.scene_id,
    rehearsalMark: row.rehearsal_mark,
    ownerMarkerId: isMarkerBlockType(row.type) ? undefined : row.owner_marker_id,
    markerMeta: cleanMarkerMeta(row.marker_meta),
  };
}

function manifestSkeleton(entry: ScriptBlockManifestEntry): Block {
  return {
    ...entry,
    content: "",
    stageComment: null,
    forceShowCharacterName: false,
    characterIds: [],
    characterAnnotations: {},
  };
}

async function loadWindow(productionId: string, versionId: string, start: number, limit: number) {
  const loaded = await loadVersionBlockRange(versionId, start, limit);
  return {
    start,
    blocks: loaded.blocks,
    tags: await getBlockTagsByIds(productionId, loaded.blocks.map((block) => block.id)),
  };
}

export async function loadScriptWindowBootstrap(
  productionId: string,
  versionId: string,
  requestedStart: number,
  limit: number,
  attempt = 0,
): Promise<ScriptWindowBootstrap | null> {
  const pool = getPool();
  const [manifestRes, scenesRes, charsRes, config, tagGroups, pageMap, orderMetaRes] = await Promise.all([
    pool.query<ManifestRow>(MANIFEST_SQL, [versionId]),
    pool.query<SceneRow>(
      `${VERSION_SCENES_FROM_MARKERS_CTE}
       SELECT ms.id, COALESCE(ms.marker_meta->>'name', '') AS name,
              ms.sort_order, ms.parent_id
       FROM marker_scenes ms ORDER BY ms.sort_order`,
      [versionId],
    ),
    pool.query<CharRow>(
      `SELECT cv.character_id AS id, cv.name, cv.sort_order, cv.is_aggregate,
              COALESCE(array_remove(array_agg(ca.member_id ORDER BY ca.member_id), NULL), ARRAY[]::text[]) AS member_ids
       FROM character_version cv
       LEFT JOIN character_aggregate ca ON ca.aggregate_id = cv.character_id
       WHERE cv.version_id = $1
       GROUP BY cv.character_id, cv.name, cv.sort_order, cv.is_aggregate
       ORDER BY cv.sort_order`,
      [versionId],
    ),
    getScriptConfig(productionId, versionId),
    listTagGroups(productionId),
    getEstimatedPageMap(productionId, versionId),
    pool.query<OrderMetaRow>(ORDER_META_SQL, [versionId, productionId]),
  ]);
  if (!config || orderMetaRes.rows.length === 0) return null;

  const manifest = manifestRes.rows.map(manifestEntry);
  const maxStart = Math.max(0, manifest.length - 1);
  const normalizedStart = Number.isFinite(requestedStart) ? Math.floor(requestedStart) : 0;
  const start = Math.max(0, Math.min(normalizedStart, maxStart));
  const window = await loadWindow(productionId, versionId, start, limit);
  const verifiedMeta = await pool.query<OrderMetaRow>(ORDER_META_SQL, [versionId, productionId]);
  if (
    verifiedMeta.rows[0]?.revision !== orderMetaRes.rows[0].revision
    || Number(orderMetaRes.rows[0].total_count) !== manifest.length
  ) {
    return attempt < 2
      ? loadScriptWindowBootstrap(productionId, versionId, requestedStart, limit, attempt + 1)
      : null;
  }
  const labels = buildMarkerLabelIndex(manifest.map(manifestSkeleton));

  return {
    versionId,
    orderRevision: orderMetaRes.rows[0].revision,
    manifest,
    window,
    scenes: scenesRes.rows.map((row) => ({
      id: row.id,
      number: labels.labelByMarkerId.get(row.id) ?? "",
      name: row.name,
      parentId: row.parent_id,
    })),
    characters: charsRes.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isAggregate: row.is_aggregate,
      memberIds: row.member_ids ?? [],
    })),
    config,
    tagGroups,
    pageMap,
  };
}

export async function loadScriptWindow(
  productionId: string,
  versionId: string,
  requestedStart: number,
  limit: number,
  attempt = 0,
): Promise<ScriptWindowResponse | null> {
  const pool = getPool();
  const orderMetaRes = await pool.query<OrderMetaRow>(ORDER_META_SQL, [versionId, productionId]);
  if (orderMetaRes.rows.length === 0) return null;
  const totalCount = Number(orderMetaRes.rows[0].total_count);
  const normalizedStart = Number.isFinite(requestedStart) ? Math.floor(requestedStart) : 0;
  const start = Math.max(0, Math.min(normalizedStart, Math.max(0, totalCount - 1)));
  const window = await loadWindow(productionId, versionId, start, limit);
  const verifiedMeta = await pool.query<OrderMetaRow>(ORDER_META_SQL, [versionId, productionId]);
  if (verifiedMeta.rows[0]?.revision !== orderMetaRes.rows[0].revision) {
    return attempt < 2
      ? loadScriptWindow(productionId, versionId, requestedStart, limit, attempt + 1)
      : null;
  }
  return {
    versionId,
    orderRevision: orderMetaRes.rows[0].revision,
    totalCount,
    window,
  };
}
