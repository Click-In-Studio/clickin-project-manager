import { getPool } from "../pg";
import type { Block } from "./script-types";
import { MARKER_TYPES_SQL } from "./script-marker-sql";
import { cleanMarkerMeta, fromDbType, isChapterSceneMarkerType, isMarkerBlockType, type BlockRow, type ScCharRow } from "./script-row-model";

// 正文块读取（#486 从 lib/db.ts 搬出）：按 version 装块序列 / 定点装块 / 只取 id。
// 单独成文件是为了切断环：page-map-db 要读块，而 script-state-db 的 saveScriptConfig
// 要触发 page-map 重算——块读取放最底层，方向固定为 块读取 ← page-map ← state。

export const VERSION_BLOCK_ROWS_SQL = `SELECT
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

export type LoadedVersionBlocks = {
  blocks: Block[];
  sortKeys: Map<string, string>;
  snapshotIds: Map<string, string>;
};

export async function assembleVersionBlocks(rows: BlockRow[]): Promise<LoadedVersionBlocks> {
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
