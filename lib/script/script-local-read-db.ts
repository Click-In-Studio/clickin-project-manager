import { getPool } from "../pg";
import type { Block, Character } from "./script-types";
import { MARKER_TYPES_SQL } from "./script-marker-sql";
import { loadVersionBlocksByIds } from "./script-block-read-db";
import { buildMarkerLabelIndex } from "./script-generated-labels";
import { isMarkerBlock, withLegacyOwnershipProjection, withMarkerOwnership } from "./script-marker-blocks";
import { cleanMarkerMeta, fromDbType, type BlockRow } from "./script-row-model";
import { manifestEntryToSkeleton } from "./script-window-types";

/** 局部读的共享结构：正文、角色挂载、批注不进全本索引。标记标题保留旧 content 兜底。 */
export async function loadScriptReadStructure(versionId: string) {
  const { rows } = await getPool().query<BlockRow>(
    `SELECT s.id AS snapshot_id, sv.block_id, sv.sort_key, s.type,
            s.scene_id, s.rehearsal_mark, s.owner_marker_id, s.marker_meta,
            CASE WHEN s.type IN (${MARKER_TYPES_SQL}) THEN s.content ELSE '' END AS content,
            NULL::text AS stage_comment, false AS force_show_character_name
       FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
      WHERE sv.version_id = $1 ORDER BY sv.sort_key`, [versionId],
  );
  const skeletons = rows.map(row => ({
    ...manifestEntryToSkeleton({
      id: row.block_id, ...fromDbType(row.type), sceneId: row.scene_id,
      rehearsalMark: row.rehearsal_mark, ownerMarkerId: row.owner_marker_id,
      markerMeta: cleanMarkerMeta(row.marker_meta),
    }),
    content: row.content,
  }));
  const blocks = withLegacyOwnershipProjection(withMarkerOwnership(skeletons));
  return {
    blocks,
    byId: new Map(blocks.map(block => [block.id, block])),
    labels: buildMarkerLabelIndex(blocks),
    markerById: new Map(blocks.filter(isMarkerBlock).map(block => [block.id, block])),
  };
}

export type ScriptReadStructure = Awaited<ReturnType<typeof loadScriptReadStructure>>;

/** 只装目标正文，归属从完整轻量结构取，不能在被截断的窗口上重新计算。 */
export async function loadScriptReadBlocks(versionId: string, structure: ScriptReadStructure, ids: string[]): Promise<Block[]> {
  const blocks = await loadVersionBlocksByIds(versionId, ids);
  return blocks.map(block => {
    const context = structure.byId.get(block.id);
    return context ? {
      ...block, sceneId: context.sceneId, rehearsalMark: context.rehearsalMark,
      ownerMarkerId: context.ownerMarkerId, markerMeta: context.markerMeta,
    } : block;
  });
}

/** 方言要判断全项目同名角色；只读名字和身份，不拖人物小传等详情。 */
export async function loadScriptCharacterNames(versionId: string, ids?: string[]): Promise<Character[]> {
  const { rows } = await getPool().query<{ id: string; name: string; is_aggregate: boolean }>(
    `SELECT character_id AS id, name, is_aggregate FROM character_version
      WHERE version_id = $1 ${ids ? "AND character_id = ANY($2::text[])" : ""}
      ORDER BY sort_order`, ids ? [versionId, ids] : [versionId],
  );
  return rows.map(row => ({ id: row.id, name: row.name, isAggregate: row.is_aggregate }));
}
