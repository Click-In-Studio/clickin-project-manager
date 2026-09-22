import { getPool } from "../pg";
import type { Block, Character } from "./script-types";
import { handleBlockContentChanged, handleBlockDeleted } from "../ops/cue-db";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "./script-marker-blocks";
import { genSnapshotId } from "./script-row-model";
import { deleteCharacterRowsInTx, deleteSnapshotRowsInTx, ensureSceneAnchorsInTx, insertSnapshotRowsInTx, snapshotRowFromBlock, updateSnapshotRowInTx, upsertCharacterRowsInTx, type SnapshotRow } from "./script-row-tx";
import { finalizeMarkerInvariantsInTx, markerStructureBlocksInTx } from "./script-marker-tx";
import { scheduleEstimatedPageMapSave } from "./page-map-db";

// 整批写入某 version 的内容（#486 从 lib/db.ts 搬出，原名 flushToDBVersioned）。
// 定位：**测试 / 修复专用的批量写原语**，不是编辑器的写路径，生产代码零调用（#625）。
// 它绕过 applyPatchToDB 的 op 级归一化直接落行，然后在收尾跑一遍全量标记归一化——
// 正因如此，只有两种调用方有资格用它：
//   - 需要「先写坏、再验证归一化能修回来」的修复场景（tests/script/marker-db-integration.ts）
//   - 行为用例 tests/script/write-version-content.test.ts
// 造数一律走 applyPatchToDB（tests/_support/factories.ts），不要为省事回到这里。

export type DbBlock = Block & { lexKey: string };
// 写入时带上块当前的 snapshot_id；`sn_new_` 前缀表示新块，由本函数分配真实 id
export type SnapshotDbBlock = DbBlock & { snapshotId: string };
export type DbChar = Character & { sortOrder: number };

// 只有块与角色：scene_version 是标记的派生读模型（编辑器从不直写，导入的直写也会被
// 整版同步覆盖），这里不再提供 upsertScenes / deleteSceneIds（#635）。
export type VersionContentWrite = {
  upsertBlocks: SnapshotDbBlock[];
  deleteSnapshotIds: string[];  // snapshot_ids to remove from this version
  upsertChars: DbChar[];
  deleteCharIds: string[];
};

/**
 * 把一批块 / 角色整体写进 versionId。块按 snapshot 就地 upsert（版本体系已退役，
 * 引用数恒为 1，不再 copy-on-write，#634），角色按 version 行 upsert；收尾走
 * finalizeMarkerInvariantsInTx 整版重算，提交后触发 cue 漂移与页码重算。
 */
export async function writeVersionContent(
  productionId: string,
  versionId: string,
  payload: VersionContentWrite,
): Promise<void> {
  const { upsertBlocks: rawUpsertBlocks, deleteSnapshotIds, upsertChars, deleteCharIds } = payload;
  const upsertBlocks = withLegacyOwnershipProjection(withMarkerOwnership(rawUpsertBlocks));
  const blocksChanged = upsertBlocks.length > 0 || deleteSnapshotIds.length > 0;

  if (!blocksChanged && !upsertChars.length && !deleteCharIds.length) return;

  // ── Phase 1: snapshot pre-flush for cue drift ─────────────────────────────
  const oldContents  = new Map<string, string>(); // snapshot_id → old content
  const deleteRows: Array<{ snapshotId: string; blockId: string; prevId: string | null; nextId: string | null }> = [];

  if (upsertBlocks.length > 0) {
    const snIds = upsertBlocks.map(b => b.snapshotId);
    const res = await getPool().query<{ id: string; content: string }>(
      "SELECT id, content FROM script WHERE id = ANY($1::text[])", [snIds]
    );
    for (const r of res.rows) oldContents.set(r.id, r.content);
  }

  if (deleteSnapshotIds.length > 0) {
    const res = await getPool().query<{ id: string; block_id: string; prev_id: string | null; next_id: string | null }>(
      `WITH ordered AS (
         SELECT sv.snapshot_id AS id, sv.block_id,
           LAG(sv.snapshot_id)  OVER (ORDER BY sv.sort_key) AS prev_id,
           LEAD(sv.snapshot_id) OVER (ORDER BY sv.sort_key) AS next_id
         FROM script_version sv WHERE sv.version_id = $1
       )
       SELECT id, block_id, prev_id, next_id FROM ordered WHERE id = ANY($2::text[])`,
      [versionId, deleteSnapshotIds]
    );
    for (const r of res.rows) deleteRows.push({ snapshotId: r.id, blockId: r.block_id, prevId: r.prev_id, nextId: r.next_id });
  }

  // ── Phase 2: main transaction ─────────────────────────────────────────────
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const previousMarkerStructure = blocksChanged ? await markerStructureBlocksInTx(client, versionId) : [];

    await upsertCharacterRowsInTx(client, productionId, versionId, upsertChars);
    await deleteCharacterRowsInTx(client, versionId, deleteCharIds);
    // 归属投影已把正文块的 sceneId 指到标记 id，先立 identity 锚（与导入同一做法）
    await ensureSceneAnchorsInTx(client, productionId,
      [...new Set(upsertBlocks.flatMap((b) => b.sceneId ? [b.sceneId] : []))]);

    const newRows: SnapshotRow[] = [];
    for (const block of upsertBlocks) {
      if (block.snapshotId.startsWith('sn_new_')) {
        newRows.push(snapshotRowFromBlock(block, { snapshotId: genSnapshotId(), blockId: block.id, lexKey: block.lexKey }));
      } else {
        await updateSnapshotRowInTx(client, versionId,
          snapshotRowFromBlock(block, { snapshotId: block.snapshotId, blockId: block.id, lexKey: block.lexKey }), { sortKey: true });
      }
    }
    await insertSnapshotRowsInTx(client, productionId, versionId, newRows);
    await deleteSnapshotRowsInTx(client, deleteRows);

    if (blocksChanged) {
      await finalizeMarkerInvariantsInTx(client, productionId, versionId, { mode: "full", previousMarkerStructure });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ── Phase 3: cue drift (best-effort) + page map (fire-and-forget) ─────────
  const driftJobs: Promise<void>[] = [];
  for (const d of deleteRows) driftJobs.push(handleBlockDeleted(d.snapshotId, d.prevId, d.nextId, versionId));
  for (const block of upsertBlocks) {
    const old = oldContents.get(block.snapshotId);
    if (old !== undefined && old !== block.content)
      driftJobs.push(handleBlockContentChanged(block.snapshotId, block.snapshotId, old, block.content, versionId));
  }
  if (driftJobs.length > 0) await Promise.allSettled(driftJobs);
  if (blocksChanged) {
    void scheduleEstimatedPageMapSave(productionId, versionId, "full")
      .catch(err => console.error("[page-map] update error:", err));
  }
}
