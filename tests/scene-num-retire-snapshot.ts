/**
 * Pre-migration snapshot for migrate-scene-num-retire invariance tests（#159）。
 *
 * 这支迁移删的是 scene_version.num——marker 化之前的场次号存储。真正要守的
 * 不变量只有一条：**场次号不丢**。marker 化之后场次号已经不落库，而是由
 * marker 层级实时生成（buildMarkerLabelIndex），num 只是没人读的历史残值。
 *
 * 工厂数据（走真实写路径造 marker，marker 才是真相源）：
 *   · 一个演出 + 两个 chapter marker（生成号「第一幕」「第二幕」）
 *   · 迁移前用裸 SQL 把 num 塞成**与生成号不一致**的存量残值——最刁钻的形态：
 *     若哪天有人把 num 当真相源读回来，这个测试会立刻炸；迁移后读到的号必须
 *     仍是 marker 生成的那个。
 *
 * isMigrationNeeded: scene_version.num 列还在。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { createProduction, getActiveVersionId, applyPatchToDB, listScenesByVersion } from "@/lib/db";
import type { Block } from "@/lib/script-types";

export const SCENE_NUM_RETIRE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "scene-num-retire-migration-snapshot.json",
);

export type SceneNumRetireSnapshot = {
  prodId: string;
  versionId: string;
  /** scene_id → 迁移前由 marker 生成的场次号（迁移后必须一字不差） */
  numberBySceneId: Record<string, string>;
  /** scene_id → 迁移前 scene_version.name（派生读模型的其余列不该受影响） */
  nameBySceneId: Record<string, string>;
  /** 塞进 num 列的存量残值——刻意与生成号不一致 */
  fossilNum: string;
};

export async function isSceneNumRetirePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'scene_version' AND column_name = 'num'
  `);
  return rows.length > 0;
}

function chapterMarker(id: string, name: string): Block {
  return {
    id,
    type: "chapter_marker",
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    markerMeta: { name },
  };
}

export async function createSceneNumRetirePreMigrationData(
  pool: Pool,
  ownerUserId: string,
): Promise<SceneNumRetireSnapshot> {
  const prodId = `test-scenenum-${Date.now().toString(36)}`;
  await createProduction(prodId, "场次号退役迁移工厂演出", ownerUserId);
  const versionId = (await getActiveVersionId(prodId))!;

  const first = `${prodId}-mk1`;
  const second = `${prodId}-mk2`;
  await applyPatchToDB(prodId, versionId, {
    clientSeq: 1,
    blockOps: [
      { op: "insert", block: chapterMarker(first, "潮汐来信"), afterId: null },
      { op: "insert", block: chapterMarker(second, "灯塔之下"), afterId: first },
    ],
    charOps: [],
    sceneOps: [],
  });

  // 刁钻形态：num 塞成与 marker 生成号不一致的残值
  const fossilNum = "旧-99";
  await pool.query(
    "UPDATE scene_version SET num = $2 WHERE version_id = $1",
    [versionId, fossilNum],
  );

  const scenes = await listScenesByVersion(versionId);
  return {
    prodId,
    versionId,
    numberBySceneId: Object.fromEntries(scenes.map((s) => [s.id, s.number])),
    nameBySceneId: Object.fromEntries(scenes.map((s) => [s.id, s.name])),
    fossilNum,
  };
}
