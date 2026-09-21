import { getPool } from "../pg";
import type { Pool } from "pg";
import type { Block } from "./script-types";
import { buildMarkerLabelIndex, type MarkerLabelIndex } from "./script-generated-labels";

// 标记标签索引（#486 从 lib/db.ts 搬出）：按 version 的 marker_structure_revision 缓存
// 「幕 / 场 / 排练标记 → 显示标签」索引，同 revision 命中直接返回，并发装载合流。

type MarkerLabelCacheEntry = { revision: string; index: MarkerLabelIndex };

const scriptMarkerGlobals = globalThis as typeof globalThis & {
  __scriptMarkerLabelCache?: Map<string, MarkerLabelCacheEntry>;
  __scriptMarkerLabelLoads?: Map<string, Promise<MarkerLabelCacheEntry | null>>;
};

const MARKER_LABEL_CACHE_LIMIT = 64;
const markerLabelCache = scriptMarkerGlobals.__scriptMarkerLabelCache ??= new Map();
const markerLabelLoads = scriptMarkerGlobals.__scriptMarkerLabelLoads ??= new Map();

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
