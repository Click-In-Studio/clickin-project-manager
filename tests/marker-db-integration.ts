import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  applyPatchToDB,
  createProduction,
  createVersion,
  deleteProduction,
  getActiveVersionId,
  loadPageMap,
  getMarkerLabelIndex,
  rollbackToVersion,
  savePageMap,
  saveScriptConfig,
} from "../lib/db";
import { getPool } from "../lib/pg";
import { DEFAULT_SCRIPT_CONFIG, type Block } from "../lib/script-types";

const productionId = `marker_test_${randomUUID()}`;
const chapterId = `chapter_${randomUUID()}`;

function marker(id: string, type: Block["type"], parentMarkerId: string | null): Block {
  return {
    id,
    type,
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: type === "chapter_marker" || type === "scene_marker" ? id : null,
    rehearsalMark: null,
    forceShowCharacterName: false,
    markerMeta: { parentMarkerId },
  };
}

async function revision(versionId: string): Promise<string> {
  const result = await getPool().query<{ revision: string }>(
    "SELECT marker_structure_revision::text AS revision FROM version WHERE id = $1",
    [versionId],
  );
  return result.rows[0].revision;
}

async function mutateInChildProcess(
  productionId: string,
  versionId: string,
  chapterId: string,
  sceneId: string,
) {
  const snapshotId = `snapshot_${randomUUID()}`;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO scene (id, production_id) VALUES ($1, $2)",
      [sceneId, productionId],
    );
    await client.query(
      `INSERT INTO script
         (id, block_id, production_id, sort_key, scene_id, type, content, marker_meta)
       VALUES ($1, $2, $3, 'zzzz', $2, 'scene_marker', '', $4::jsonb)`,
      [snapshotId, sceneId, productionId, JSON.stringify({ parentMarkerId: chapterId })],
    );
    await client.query(
      "INSERT INTO script_version (snapshot_id, version_id, block_id, sort_key) VALUES ($1, $2, $3, 'zzzz')",
      [snapshotId, versionId, sceneId],
    );
    await client.query(
      "UPDATE version SET marker_structure_revision = marker_structure_revision + 1 WHERE id = $1",
      [versionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const labels = await getMarkerLabelIndex(versionId, pool);
  assert.equal(labels.labelByMarkerId.get(sceneId), "0-1");
}

async function run() {
  await createProduction(productionId, "Marker integration test");
  try {
    const sourceVersionId = await getActiveVersionId(productionId);
    assert.ok(sourceVersionId);
    const chapter = marker(chapterId, "chapter_marker", null);
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 1,
      blockOps: [{ op: "insert", block: chapter, afterId: null }],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "1");
    const scriptConfig = { ...DEFAULT_SCRIPT_CONFIG, openingChapterMarkerId: chapterId };
    await saveScriptConfig(productionId, sourceVersionId, {
      ...scriptConfig,
      textLayoutMode: "compact",
    });
    await saveScriptConfig(productionId, sourceVersionId, scriptConfig);

    const cached = await getMarkerLabelIndex(sourceVersionId);
    const textBlock = marker(`text_${randomUUID()}`, "dialogue", null);
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 2,
      blockOps: [{ op: "insert", block: textBlock, afterId: chapterId }],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "1");
    assert.equal(await getMarkerLabelIndex(sourceVersionId), cached);
    const insertedTextOwnership = await getPool().query<{ owner_marker_id: string | null }>(
      `SELECT s.owner_marker_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND sv.block_id = $2`,
      [sourceVersionId, textBlock.id],
    );
    assert.equal(insertedTextOwnership.rows[0]?.owner_marker_id, chapterId);
    const ownedTextBlock = { ...textBlock, sceneId: chapterId, ownerMarkerId: chapterId };

    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 3,
      blockOps: [{ op: "update", block: { ...ownedTextBlock, content: "Text edit" } }],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "1");
    assert.equal(await getMarkerLabelIndex(sourceVersionId), cached);

    await getPool().query(
      `UPDATE script s
       SET owner_marker_id = NULL
       FROM script_version sv
       WHERE sv.snapshot_id = s.id AND sv.version_id = $1 AND sv.block_id = $2`,
      [sourceVersionId, textBlock.id],
    );
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 30,
      blockOps: [{ op: "update", block: { ...ownedTextBlock, content: "Text edit" } }],
      charOps: [],
      sceneOps: [],
    });
    const repairedTextOwnership = await getPool().query<{ owner_marker_id: string | null }>(
      `SELECT s.owner_marker_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND sv.block_id = $2`,
      [sourceVersionId, textBlock.id],
    );
    assert.equal(repairedTextOwnership.rows[0]?.owner_marker_id, chapterId);
    await getPool().query(
      `UPDATE script s
       SET owner_marker_id = NULL
       FROM script_version sv
       WHERE sv.snapshot_id = s.id AND sv.version_id = $1 AND sv.block_id = $2`,
      [sourceVersionId, textBlock.id],
    );
    const splitBlock = marker(`split_${randomUUID()}`, "dialogue", null);
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 31,
      blockOps: [
        { op: "insert", block: splitBlock, afterId: textBlock.id },
        { op: "update", block: { ...ownedTextBlock, content: "Text" } },
      ],
      charOps: [],
      sceneOps: [],
    });
    const splitOwnership = await getPool().query<{ block_id: string; owner_marker_id: string | null }>(
      `SELECT sv.block_id, s.owner_marker_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[])`,
      [sourceVersionId, [textBlock.id, splitBlock.id]],
    );
    assert.deepEqual(new Map(splitOwnership.rows.map((row) => [row.block_id, row.owner_marker_id])), new Map([
      [textBlock.id, chapterId],
      [splitBlock.id, chapterId],
    ]));

    await getPool().query(
      `UPDATE script s
       SET owner_marker_id = NULL
       FROM script_version sv
       WHERE sv.snapshot_id = s.id AND sv.version_id = $1 AND sv.block_id = $2`,
      [sourceVersionId, textBlock.id],
    );
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 32,
      blockOps: [
        { op: "delete", id: splitBlock.id },
        { op: "update", block: { ...ownedTextBlock, content: "Text merged" } },
      ],
      charOps: [],
      sceneOps: [],
    });
    const mergedOwnership = await getPool().query<{ owner_marker_id: string | null }>(
      `SELECT s.owner_marker_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND sv.block_id = $2`,
      [sourceVersionId, textBlock.id],
    );
    assert.equal(mergedOwnership.rows[0]?.owner_marker_id, chapterId);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const storedPageMap = await loadPageMap(productionId) ?? {};
    await savePageMap(productionId, storedPageMap);
    const pageMapRowBefore = await getPool().query<{ xmin: string }>(
      "SELECT xmin::text FROM production WHERE id = $1",
      [productionId],
    );
    await savePageMap(productionId, storedPageMap);
    const pageMapRowAfter = await getPool().query<{ xmin: string }>(
      "SELECT xmin::text FROM production WHERE id = $1",
      [productionId],
    );
    assert.equal(pageMapRowAfter.rows[0]?.xmin, pageMapRowBefore.rows[0]?.xmin);

    const scopedSceneVersion = await createVersion(productionId, sourceVersionId, "Scoped scene sync");
    const laterSceneId = `scene_${randomUUID()}`;
    const laterScene = marker(laterSceneId, "scene_marker", chapterId);
    await applyPatchToDB(productionId, scopedSceneVersion.id, {
      clientSeq: 33,
      blockOps: [{ op: "insert", block: laterScene, afterId: chapterId }],
      charOps: [],
      sceneOps: [
        { op: "upsert", scene: { id: laterSceneId, number: "", name: "Later", parentId: chapterId } },
        { op: "reorder", ids: [chapterId, laterSceneId] },
      ],
    });
    const laterSceneBefore = await getPool().query<{ xmin: string }>(
      "SELECT xmin::text FROM scene_version WHERE version_id = $1 AND scene_id = $2",
      [scopedSceneVersion.id, laterSceneId],
    );
    const middleSceneId = `scene_${randomUUID()}`;
    await applyPatchToDB(productionId, scopedSceneVersion.id, {
      clientSeq: 34,
      blockOps: [{
        op: "insert",
        block: marker(middleSceneId, "scene_marker", chapterId),
        afterId: chapterId,
      }],
      charOps: [],
      sceneOps: [
        { op: "upsert", scene: { id: middleSceneId, number: "", name: "Middle", parentId: chapterId } },
        { op: "reorder", ids: [chapterId, middleSceneId, laterSceneId] },
      ],
    });
    const laterSceneAfter = await getPool().query<{ xmin: string }>(
      "SELECT xmin::text FROM scene_version WHERE version_id = $1 AND scene_id = $2",
      [scopedSceneVersion.id, laterSceneId],
    );
    assert.equal(laterSceneAfter.rows[0]?.xmin, laterSceneBefore.rows[0]?.xmin);

    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 4,
      blockOps: [{
        op: "update",
        block: { ...chapter, markerMeta: { parentMarkerId: null, name: "Renamed" } },
      }],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "1");
    assert.equal(await getMarkerLabelIndex(sourceVersionId), cached);

    const cancelledMarkerId = `scene_${randomUUID()}`;
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 5,
      blockOps: [
        { op: "insert", block: marker(cancelledMarkerId, "scene_marker", chapterId), afterId: chapterId },
        { op: "delete", id: cancelledMarkerId },
      ],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "1");
    assert.equal(await getMarkerLabelIndex(sourceVersionId), cached);

    const childSceneId = `scene_${randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [__filename, "mutate", productionId, sourceVersionId, chapterId, childSceneId],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Child exited with ${code}`)));
    });
    const refreshed = await getMarkerLabelIndex(sourceVersionId);
    assert.notEqual(refreshed, cached);
    assert.equal(refreshed.labelByMarkerId.get(childSceneId), "0-1");

    const failedMarkerId = `scene_${randomUUID()}`;
    await assert.rejects(
      applyPatchToDB(productionId, sourceVersionId, {
        clientSeq: 6,
        blockOps: [
          { op: "insert", block: marker(failedMarkerId, "scene_marker", chapterId), afterId: chapterId },
          { op: "update", block: chapter, tags: [{ groupId: "missing", optionId: null, value: null }] },
        ],
        charOps: [],
        sceneOps: [],
      }),
      /TAG_INVALID_GROUP/,
    );
    assert.equal(await revision(sourceVersionId), "2");
    const failedMarker = await getPool().query(
      "SELECT 1 FROM script_version WHERE version_id = $1 AND block_id = $2",
      [sourceVersionId, failedMarkerId],
    );
    assert.equal(failedMarker.rowCount, 0);

    const repairedChapterId = `chapter_${randomUUID()}`;
    const secondRepairedChapterId = `chapter_${randomUUID()}`;
    const chapterRowBeforeScopedSync = await getPool().query<{ xmin: string }>(
      "SELECT xmin::text FROM scene_version WHERE version_id = $1 AND scene_id = $2",
      [sourceVersionId, chapterId],
    );
    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 7,
      blockOps: [
        { op: "reorder", ids: [chapterId, textBlock.id, childSceneId] },
        {
          op: "insert",
          block: marker(repairedChapterId, "chapter_marker", null),
          afterId: childSceneId,
        },
        {
          op: "insert",
          block: marker(secondRepairedChapterId, "chapter_marker", null),
          afterId: repairedChapterId,
        },
      ],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "3");
    const chapterRowAfterScopedSync = await getPool().query<{ xmin: string }>(
      "SELECT xmin::text FROM scene_version WHERE version_id = $1 AND scene_id = $2",
      [sourceVersionId, chapterId],
    );
    assert.equal(chapterRowAfterScopedSync.rows[0]?.xmin, chapterRowBeforeScopedSync.rows[0]?.xmin);
    const repairedOrder = await getPool().query<{ block_id: string; type: Block["type"]; owner_marker_id: string | null }>(
      `SELECT sv.block_id, s.type::text AS type, s.owner_marker_id
       FROM script_version sv
       JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1
       ORDER BY sv.sort_key`,
      [sourceVersionId],
    );
    const repairedChapterIndex = repairedOrder.rows.findIndex((row) => row.block_id === repairedChapterId);
    assert.ok(repairedChapterIndex > 0);
    assert.equal(repairedOrder.rows[repairedChapterIndex - 1].type, "dialogue");
    assert.equal(repairedOrder.rows[repairedChapterIndex - 1].owner_marker_id, childSceneId);
    const secondRepairedChapterIndex = repairedOrder.rows.findIndex((row) => row.block_id === secondRepairedChapterId);
    assert.ok(secondRepairedChapterIndex > repairedChapterIndex);
    assert.equal(repairedOrder.rows[secondRepairedChapterIndex - 1].type, "dialogue");

    const child = await createVersion(productionId, sourceVersionId, "Child");
    assert.equal(await revision(child.id), "3");
    const rollback = await rollbackToVersion(child.id, sourceVersionId, productionId, "Rollback");
    assert.equal(await revision(rollback.id), "3");
  } finally {
    await deleteProduction(productionId);
  }
}

const isChild = process.argv[2] === "mutate";
const task = isChild
  ? mutateInChildProcess(process.argv[3], process.argv[4], process.argv[5], process.argv[6])
  : run();

task
  .then(() => { if (!isChild) console.log("marker database integration fixtures passed"); })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
