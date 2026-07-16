import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  applyPatchToDB,
  createProduction,
  createVersion,
  deleteProduction,
  getActiveVersionId,
  getMarkerLabelIndex,
  rollbackToVersion,
} from "../lib/db";
import { getPool } from "../lib/pg";
import type { Block } from "../lib/script-types";

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

    await applyPatchToDB(productionId, sourceVersionId, {
      clientSeq: 3,
      blockOps: [{ op: "update", block: { ...textBlock, content: "Text edit" } }],
      charOps: [],
      sceneOps: [],
    });
    assert.equal(await revision(sourceVersionId), "1");
    assert.equal(await getMarkerLabelIndex(sourceVersionId), cached);

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
        clientSeq: 5,
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

    const child = await createVersion(productionId, sourceVersionId, "Child");
    assert.equal(await revision(child.id), "2");
    const rollback = await rollbackToVersion(child.id, sourceVersionId, productionId, "Rollback");
    assert.equal(await revision(rollback.id), "2");
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
