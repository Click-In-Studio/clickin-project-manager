import { getPool } from "../pg";
import type { Block, MarkerMeta } from "./script-types";
import { importCueColumnsInTx } from "../ops/cue-list-db";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "./script-marker-blocks";
import { randomUUID } from "node:crypto";
import type { ImportTagChanges } from "../import/types";
import { ensureSceneAnchorsInTx, insertSnapshotRowsInTx, snapshotRowFromBlock, upsertCharacterRowsInTx } from "./script-row-tx";
import { finalizeMarkerInvariantsInTx, markerStructureBlocksInTx } from "./script-marker-tx";
import { scheduleEstimatedPageMapSave } from "./page-map-db";

// 导入落库（#486 从 lib/db.ts 搬出）：importScriptToVersion 把导入管线（lib/import）的结果
// 一次性原子替换进目标 version——构作、剧本内容、Cue 全量以本次为准（DEV_GUIDE §8「联合导入」）。
// 测试工厂不得用它造数（AGENTS §6）。

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
    blockTagAssignments?: Array<{ blockId: string; groupId: string; optionId: string }>;
    tagChanges?: ImportTagChanges;
    aggregateMembers?: Array<{ aggregateId: string; memberIds: string[] }>;
    /** 开场章是否显示；开场章本身 = 排在最前的 chapter_marker，读时派生不落库（#636） */
    showOpeningChapter?: boolean;
    stageDelimiters?: { open: string; close: string };
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

    // Clear all blocks from this version: 物理删 snapshot（script_version 随 FK 级联），
    // block_tag 按逻辑 block_id 一并清。版本体系已退役，不再按引用数 GC（#634）。
    const removedSV = await client.query<{ snapshot_id: string; block_id: string }>(
      "SELECT snapshot_id, block_id FROM script_version WHERE version_id = $1",
      [versionId]
    );
    if (removedSV.rows.length > 0) {
      await client.query(
        "DELETE FROM block_tag WHERE block_id = ANY($1::text[])",
        [removedSV.rows.map(r => r.block_id)]
      );
      await client.query(
        "DELETE FROM script WHERE id = ANY($1::text[])",
        [removedSV.rows.map(r => r.snapshot_id)]
      );
    }

    // 整版替换：本版本绑的 cue 修订行物理删（引用数守护已随 #639 退役），
    // cue_version 行随 FK 级联。锚点是软引用（无 FK），删 snapshot 不会撞约束。
    await client.query(
      "DELETE FROM cue WHERE id IN (SELECT revision_id FROM cue_version WHERE version_id = $1)",
      [versionId]
    );

    // Import is a full replacement of script + dramaturgy for this version.
    // scene_version 是标记的派生读模型：这里只清空 + 立 identity 锚，行由收尾的整版同步
    // 从标记重建（payload.upsertScenes 的 name / parentId / sortOrder 不直写——直写也会被同步
    // 覆盖，#635）。
    await client.query("DELETE FROM scene_version WHERE version_id = $1", [versionId]);
    await ensureSceneAnchorsInTx(client, productionId, sceneAnchorIds);
    await upsertCharacterRowsInTx(client, productionId, versionId, upsertChars);
    // 导入 payload 的 `id` 是 snapshot id、`blockId` 才是逻辑块 id（与其余路径相反）
    await insertSnapshotRowsInTx(client, productionId, versionId, upsertBlocks.map((b) =>
      snapshotRowFromBlock(b, { snapshotId: b.id, blockId: b.blockId ?? b.id, lexKey: b.lexKey },
        { forceShowCharacterName: false })));

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

    if (payload.showOpeningChapter !== undefined) {
      await client.query(
        "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2 AND production_id = $3",
        [JSON.stringify({ showOpeningChapter: payload.showOpeningChapter }), versionId, productionId],
      );
    }
    if (payload.stageDelimiters) {
      await client.query(
        "UPDATE production SET script_config = script_config || $1::jsonb WHERE id = $2",
        [JSON.stringify({ stageDelimOpen: payload.stageDelimiters.open, stageDelimClose: payload.stageDelimiters.close }), productionId],
      );
    }

    // 空场次的占位正文块等结构修复由收尾统一跑域模型补（#637），导入不再自带 SQL 扫描
    await finalizeMarkerInvariantsInTx(client, productionId, versionId, { mode: "full", previousMarkerStructure });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // 导入整版替换，页码全量重算（此前只有 patch 路径触发，#635 统一）
  void scheduleEstimatedPageMapSave(productionId, versionId, "full")
    .catch(err => console.error("[page-map] update error:", err));
}
