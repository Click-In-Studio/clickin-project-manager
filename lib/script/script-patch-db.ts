import { getPool } from "../pg";
import type { PoolClient } from "pg";
import type { Block, BlockType, Character, Scene, MarkerMeta } from "./script-types";
import { DEFAULT_SCRIPT_CONFIG } from "./script-types";
import { handleBlockContentChanged, handleBlockDeleted } from "../ops/cue-db";
import type { ScriptPatch, TagEntry } from "./script-ops";
import { keyBetween, initialKeys } from "../lex-order";
import { getMarkerChange, markerCacheUpdateBlockIds, markerHierarchyUpdateBlockIds, normalizeScriptMarkerInvariants, type MarkerChange } from "./script-marker-domain";
import { cleanMarkerMeta, genBlockId, genSnapshotId, isChapterSceneMarkerType, isMarkerBlockType, toDbType } from "./script-row-model";
import { deleteSnapshotRowsInTx, ensureSceneAnchorsInTx, insertSnapshotRowsInTx, snapshotRowFromBlock, updateSnapshotRowInTx, upsertCharacterRowsInTx, deleteCharacterRowsInTx } from "./script-row-tx";
import { finalizeMarkerInvariantsInTx } from "./script-marker-tx";
import { scheduleEstimatedPageMapSave } from "./page-map-db";

// 编辑器 / 协作的写路径（#486 从 lib/db.ts 搬出）：applyPatchToDB 在一个事务里按 ScriptPatch
// 的 op 序列落库，维护标记结构不变量与 cue 漂移，提交后异步重算页码。
// 三枚 tag helper 只在这个事务内用，块标签的普通 CRUD 在 script-block-tag-db。

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
 *    the same version so lexKey computation never interleaves.
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
  const driftUpdates: Array<{ snapshotId: string; oldContent: string; newContent: string }> = [];
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

    await deleteCharacterRowsInTx(client, versionId, [...deletedCharIds]);
    await upsertCharacterRowsInTx(client, productionId, versionId, txChars.filter(c => dirtyCharIds.has(c.id)));

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
            await ensureSceneAnchorsInTx(client, productionId, [insertBlock.sceneId]);
          }
          await insertSnapshotRowsInTx(client, productionId, versionId, [
            snapshotRowFromBlock(insertBlock, { snapshotId, lexKey },
              { rehearsalMark: insertRehearsalMark, ownerMarkerId: insertOwnerMarkerId }),
          ]);

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

          // 版本体系已退役（#634）：snapshot 引用数恒为 1，一律就地更新，不再 copy-on-write。
          // 归属列（rehearsalMark / ownerMarkerId）沿用工作态，不信客户端传的。
          await updateSnapshotRowInTx(client, versionId, snapshotRowFromBlock(updateBlock,
            { snapshotId: cur.snapshotId, lexKey: cur.lexKey },
            { rehearsalMark: cur.rehearsalMark, ownerMarkerId: cur.ownerMarkerId }));
          const oldContent = oldContentMap.get(cur.snapshotId);
          if (oldContent !== undefined && oldContent !== updateBlock.content) {
            driftUpdates.push({ snapshotId: cur.snapshotId, oldContent, newContent: updateBlock.content });
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

          await deleteSnapshotRowsInTx(client, [{ snapshotId: cur.snapshotId, blockId: op.id }]);

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
      if (sceneId) await ensureSceneAnchorsInTx(client, productionId, [sceneId]);
      await insertSnapshotRowsInTx(client, productionId, versionId, [
        snapshotRowFromBlock(block, { snapshotId, lexKey }, { sceneId, rehearsalMark: null, forceShowCharacterName: false }),
      ]);
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
    pageMapDirtyPositions = [...new Set([
      ...finalBlockChange.positions,
      ...pageMapContentPositions,
    ])].filter((position) => position >= 0).sort((a, b) => a - b);
    await finalizeMarkerInvariantsInTx(client, productionId, versionId, {
      mode: "scoped",
      affectedBlockIds: normalizedServerState ? markerCacheUpdateBlockIds(finalBlocks, finalBlockChange) : [],
      affectedSceneMarkerIds: [...affectedSceneMarkerIds],
      deletedSceneMarkerIds: [...deletedSceneMarkerIds],
      markerStructureChanged,
    });
    if (markerStructureChanged) {
      // 派生配置 openingChapterMarkerId 的多写点问题见 #636
      const openingChapterMarkerId = finalBlocks.find((block) => block.type === "chapter_marker")?.id ?? null;
      await client.query(
        "UPDATE version SET script_config = COALESCE(script_config, '{}'::jsonb) || $1::jsonb WHERE id = $2",
        [JSON.stringify({ openingChapterMarkerId }), versionId],
      );
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
      handleBlockContentChanged(u.snapshotId, u.snapshotId, u.oldContent, u.newContent, versionId)
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
