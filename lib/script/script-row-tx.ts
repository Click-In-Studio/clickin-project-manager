import type { PoolClient } from "pg";
import type { Block } from "./script-types";
import { markerMetaJson, toDbType, type DbBlockType } from "./script-row-model";

// 剧本行写 helper（#635）：script / script_version / script_character / character_version 的
// 事务内 INSERT / UPDATE / DELETE 只在这里写一份，patch / 批量写 / 导入 / 标记修复四条路径
// 都改调这里——此前同一条 INSERT 各抄一份，列表还不一致。只做行级 SQL，不做归一化、不开事务；
// 场次的 scene_version 是标记的派生读模型，由 script-marker-tx 从标记同步，这里只管 identity 锚。

/** 一行 snapshot 的全部列，已换算成库形态（type / markerMeta 由 snapshotRowFromBlock 算好） */
export type SnapshotRow = {
  snapshotId: string;
  blockId: string;
  lexKey: string;
  sceneId: string | null;
  rehearsalMark: string | null;
  ownerMarkerId: string | null;
  type: DbBlockType;
  content: string;
  stageComment: string | null;
  markerMetaJson: string;
  forceShowCharacterName: boolean;
  characterIds: string[];
  characterAnnotations: Record<string, string>;
};

/**
 * 从领域 Block 换算一行。`ids.blockId` 显式给逻辑块 id：导入路径的 `Block.id` 装的是
 * snapshot id（历史包袱），不能拿它当块 id 用；其余调用方传 `block.id` 即可。
 * `overrides` 给调用方覆盖归属列（patch 路径按前一块推导 rehearsalMark / ownerMarkerId，
 * 不信 block 自带的）。
 */
export function snapshotRowFromBlock(
  block: Block,
  ids: { snapshotId: string; blockId: string; lexKey: string },
  overrides: Partial<Pick<SnapshotRow, "sceneId" | "rehearsalMark" | "ownerMarkerId" | "forceShowCharacterName">> = {},
): SnapshotRow {
  return {
    snapshotId: ids.snapshotId,
    blockId: ids.blockId,
    lexKey: ids.lexKey,
    sceneId: block.sceneId ?? null,
    rehearsalMark: block.rehearsalMark ?? null,
    ownerMarkerId: block.ownerMarkerId ?? null,
    type: toDbType(block),
    content: block.content,
    stageComment: block.stageComment?.trim() || null,
    markerMetaJson: markerMetaJson(block),
    forceShowCharacterName: block.forceShowCharacterName ?? false,
    characterIds: block.characterIds,
    characterAnnotations: block.characterAnnotations,
    ...overrides,
  };
}

/** 整批插入 snapshot 行 + 版本关系行 + 角色关联行 */
export async function insertSnapshotRowsInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
  rows: SnapshotRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO script (id, block_id, production_id, sort_key, scene_id, rehearsal_mark, owner_marker_id, type, content, stage_comment, marker_meta, force_show_character_name)
     SELECT unnest($1::text[]), unnest($2::text[]), $3::text, unnest($4::text[]),
            unnest($5::text[]), unnest($6::text[]), unnest($7::text[]), unnest($8::block_type[]),
            unnest($9::text[]), unnest($10::text[]), unnest($11::jsonb[]), unnest($12::bool[])`,
    [
      rows.map(r => r.snapshotId), rows.map(r => r.blockId), productionId, rows.map(r => r.lexKey),
      rows.map(r => r.sceneId), rows.map(r => r.rehearsalMark), rows.map(r => r.ownerMarkerId), rows.map(r => r.type),
      rows.map(r => r.content), rows.map(r => r.stageComment), rows.map(r => r.markerMetaJson), rows.map(r => r.forceShowCharacterName),
    ],
  );
  await client.query(
    `INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key)
     SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[])`,
    [rows.map(r => r.snapshotId), versionId, rows.map(r => r.blockId), rows.map(r => r.lexKey)],
  );
  await insertSnapshotCharactersInTx(client, rows);
}

/**
 * 就地更新一行 snapshot 的内容列并整换角色关联；`sortKey: true` 才动 script_version.sort_key
 * （patch 路径的 update op 不改序，省一条语句）。
 */
export async function updateSnapshotRowInTx(
  client: PoolClient,
  versionId: string,
  row: SnapshotRow,
  opts: { sortKey?: boolean } = {},
): Promise<void> {
  await client.query(
    `UPDATE script
     SET scene_id = $1, rehearsal_mark = $2, owner_marker_id = $3, type = $4::block_type,
         content = $5, stage_comment = $6, marker_meta = $7::jsonb, force_show_character_name = $8
     WHERE id = $9`,
    [row.sceneId, row.rehearsalMark, row.ownerMarkerId, row.type,
     row.content, row.stageComment, row.markerMetaJson, row.forceShowCharacterName, row.snapshotId],
  );
  if (opts.sortKey) {
    await client.query(
      "UPDATE script_version SET sort_key = $1 WHERE snapshot_id = $2 AND version_id = $3",
      [row.lexKey, row.snapshotId, versionId],
    );
  }
  await client.query("DELETE FROM script_character WHERE script_id = $1", [row.snapshotId]);
  await insertSnapshotCharactersInTx(client, [row]);
}

async function insertSnapshotCharactersInTx(
  client: PoolClient,
  rows: Array<Pick<SnapshotRow, "snapshotId" | "characterIds" | "characterAnnotations">>,
): Promise<void> {
  const scRows = rows.flatMap(r =>
    r.characterIds.map((cid, pos) => ({ sid: r.snapshotId, cid, pos, ann: r.characterAnnotations[cid] ?? null })));
  if (scRows.length === 0) return;
  await client.query(
    `INSERT INTO script_character (script_id, character_id, position, annotation)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
    [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)],
  );
}

/**
 * 物理删 snapshot：`script_version.snapshot_id` 与 `script_character.script_id` 都是
 * `REFERENCES script(id) ON DELETE CASCADE`（db/schema.sql），删 script 行即带走两张表的行，
 * 不必先手删关系行。
 *
 * block_tag 按逻辑 block_id 无条件清，不加「别的版本还引用着吗」守护：版本体系已退役
 * （#634），一个 block_id 在一个演出里只属于当前这一条 version。**若将来重建多版本共享，
 * 这里必须先恢复引用计数守护**，否则删 head 的块会连带清掉历史版本的标签。
 */
export async function deleteSnapshotRowsInTx(
  client: PoolClient,
  rows: Array<{ snapshotId: string; blockId: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  await client.query("DELETE FROM block_tag WHERE block_id = ANY($1::text[])", [rows.map(r => r.blockId)]);
  await client.query("DELETE FROM script WHERE id = ANY($1::text[])", [rows.map(r => r.snapshotId)]);
}

/** 场次 identity 行（script.scene_id / event_schedule_item.target_scene_id 的 FK 锚），存在即跳过 */
export async function ensureSceneAnchorsInTx(
  client: PoolClient,
  productionId: string,
  sceneIds: string[],
): Promise<void> {
  if (sceneIds.length === 0) return;
  await client.query(
    `INSERT INTO scene (id, production_id)
     SELECT unnest($1::text[]), $2::text
     ON CONFLICT (id) DO NOTHING`,
    [sceneIds, productionId],
  );
}

export type CharacterRow = { id: string; name: string; sortOrder: number; isAggregate: boolean };

/** 角色 identity 行 + 版本行 upsert */
export async function upsertCharacterRowsInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
  rows: CharacterRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO character (id, production_id)
     SELECT unnest($1::text[]), $2::text
     ON CONFLICT (id) DO NOTHING`,
    [rows.map(c => c.id), productionId],
  );
  await client.query(
    `INSERT INTO character_version (character_id, version_id, name, sort_order, is_aggregate)
     SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::bool[])
     ON CONFLICT (character_id, version_id) DO UPDATE
       SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_aggregate = EXCLUDED.is_aggregate`,
    [rows.map(c => c.id), versionId, rows.map(c => c.name), rows.map(c => c.sortOrder), rows.map(c => c.isAggregate)],
  );
}

/** 只删版本行；identity 行留作 FK 锚 */
export async function deleteCharacterRowsInTx(
  client: PoolClient,
  versionId: string,
  characterIds: string[],
): Promise<void> {
  if (characterIds.length === 0) return;
  await client.query(
    "DELETE FROM character_version WHERE character_id = ANY($1::text[]) AND version_id = $2",
    [characterIds, versionId],
  );
}
