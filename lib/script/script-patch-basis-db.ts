import type { PoolClient } from "pg";
import type { ScriptPatch, TagEntry } from "./script-ops";
import { assembleVersionBlocks, VERSION_BLOCK_ROWS_SQL } from "./script-block-read-db";
import type { BlockRow, SceneRow, CharRow } from "./script-row-model";
import { VERSION_SCENES_FROM_MARKERS_CTE } from "./script-marker-sql";
import { conditionScriptPatch, type ScriptPatchBasis } from "./script-patch-basis";

/** 沿用调用方事务与剧本锁，只读取受影响块的正文，不读取整本正文。 */
export async function conditionScriptPatchInTx(
  client: PoolClient, versionId: string, patch: ScriptPatch, basis: ScriptPatchBasis, blockOrder: string[],
): Promise<ScriptPatch> {
  const ids = patch.blockOps.flatMap(op => op.op === "reorder" ? [] : [op.op === "delete" ? op.id : op.block.id]);
  const rows = await client.query<BlockRow>(
    `${VERSION_BLOCK_ROWS_SQL} AND sv.block_id = ANY($2::text[]) ORDER BY sv.sort_key FOR UPDATE OF s`, [versionId, ids],
  );
  const { blocks } = await assembleVersionBlocks(rows.rows, client);
  const tags = await client.query<{ block_id: string; group_id: string; option_id: string | null; value: string | null }>(
    "SELECT block_id, group_id, option_id, value FROM block_tag WHERE block_id = ANY($1::text[])", [ids],
  );
  const tagMap = new Map<string, TagEntry[]>();
  for (const t of tags.rows) {
    const list = tagMap.get(t.block_id) ?? [];
    list.push({ groupId: t.group_id, optionId: t.option_id, value: t.value === null ? null : Number(t.value) });
    tagMap.set(t.block_id, list);
  }
  const chars = await client.query<CharRow>(
    "SELECT character_id AS id, name, is_aggregate, sort_order FROM character_version WHERE version_id = $1 ORDER BY sort_order", [versionId],
  );
  const scenes = await client.query<SceneRow>(
    `${VERSION_SCENES_FROM_MARKERS_CTE} SELECT ms.id, COALESCE(ms.marker_meta->>'name', '') AS name, ms.parent_id, ms.sort_order FROM marker_scenes ms ORDER BY ms.sort_order`, [versionId],
  );
  return conditionScriptPatch(patch, basis, {
    blocks,
    characters: chars.rows.map(c => ({ id: c.id, name: c.name, isAggregate: c.is_aggregate })),
    scenes: scenes.rows.map(s => ({ id: s.id, name: s.name, parentId: s.parent_id, number: "" })),
  }, tagMap, blockOrder);
}
