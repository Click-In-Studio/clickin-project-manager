/**
 * Migration tests for migrate-scene-num-retire.sql（scene 过渡态收尾，#159）。
 *
 * Operating modes:
 *   Migration path (CI): global-setup 检测 scene_version.num 仍在 → 造工厂
 *     marker（真实写路径）+ 裸 SQL 塞入与生成号不一致的存量 num → 应用迁移
 *     → 写 snapshot。三层全跑。
 *   Normal path (已迁移库): 无 snapshot——schema/integrity 跑，invariance skipIf 跳过。
 *
 * Layers:
 *   1. Schema     — scene_version.num 消失；派生读模型的其余列（name/sort_order/
 *                   parent_id + 五个构作字段）一列不少，且 name/sort_order 仍 NOT NULL
 *   2. Integrity  — 全库 scene_version 每行都有对应 marker block（派生读模型无孤儿）；
 *                   迁移可重复执行
 *   3. Invariance — **场次号不丢**：迁移前由 marker 生成的号，迁移后一字不差；
 *                   name 等派生列同样原样存活
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { listScenesByVersion } from "@/lib/db";
import { makeProduction, makeScene, cleanupProduction } from "./factories";
import {
  SCENE_NUM_RETIRE_SNAPSHOT_PATH,
  type SceneNumRetireSnapshot,
} from "./scene-num-retire-snapshot";

let snapshot: SceneNumRetireSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(SCENE_NUM_RETIRE_SNAPSHOT_PATH, "utf8"),
  ) as SceneNumRetireSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("scene_version.num 已消失，派生读模型的其余列健在", async () => {
    const { rows } = await getPool().query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scene_version'
    `);
    const cols = new Map(rows.map((r) => [r.column_name, r]));
    expect([...cols.keys()], "scene_version.num 应已删除").not.toContain("num");
    for (const alive of [
      "scene_id", "version_id", "name", "sort_order", "parent_id",
      "synopsis", "action_line", "music", "stage_notes", "expected_duration",
    ]) {
      expect([...cols.keys()], `scene_version.${alive} 不应被误删`).toContain(alive);
    }
    expect(cols.get("name")?.is_nullable).toBe("NO");
    expect(cols.get("sort_order")?.is_nullable).toBe("NO");
  });

  it("scene 仍是纯身份锚点（只有 id / production_id）", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scene'
    `);
    expect(rows.map((r) => r.column_name).sort()).toEqual(["id", "production_id"]);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  // scene_version 是 marker 的派生读模型：每一行都该有一个对应的 marker block。
  // 有孤儿 = 有人绕过 syncSceneVersionsFromMarkersInTx 直写了读模型。
  it("全库 scene_version 无「没有对应 marker block」的孤儿行", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM scene_version sv
      WHERE NOT EXISTS (
        SELECT 1 FROM script_version pv
        JOIN script s ON s.id = pv.snapshot_id
        WHERE pv.version_id = sv.version_id
          AND pv.block_id = sv.scene_id
          AND s.type IN ('chapter_marker', 'scene_marker')
      )
      LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  it("scene_version 无孤儿 scene_id / version_id", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM scene_version sv
      LEFT JOIN scene s ON s.id = sv.scene_id
      LEFT JOIN version v ON v.id = sv.version_id
      WHERE s.id IS NULL OR v.id IS NULL
      LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  it("删列后写路径仍然完整，且迁移可重复执行", async () => {
    const { prodId, versionId } = await makeProduction();
    try {
      const sceneId = await makeScene(prodId, versionId, { name: "幂等验场" });
      const before = await listScenesByVersion(versionId);
      expect(before.find((s) => s.id === sceneId)?.name).toBe("幂等验场");

      // 幂等：DROP COLUMN IF EXISTS，可重放
      await getPool().query(readFileSync("db/migrate-scene-num-retire.sql", "utf8"));

      const after = await listScenesByVersion(versionId);
      expect(after).toEqual(before);
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("场次号不丢：迁移后仍由 marker 生成出迁移前的同一个号", async () => {
    const scenes = await listScenesByVersion(snapshot!.versionId);
    expect(scenes.length).toBe(Object.keys(snapshot!.numberBySceneId).length);
    for (const scene of scenes) {
      expect(scene.number, `scene ${scene.id} 的场次号应与迁移前一致`)
        .toBe(snapshot!.numberBySceneId[scene.id]);
      // 反证：读到的绝不是被删掉的 num 残值
      expect(scene.number).not.toBe(snapshot!.fossilNum);
    }
  });

  it.skipIf(!snapshot)("派生读模型的其余列（name）原样存活", async () => {
    const scenes = await listScenesByVersion(snapshot!.versionId);
    for (const scene of scenes) {
      expect(scene.name).toBe(snapshot!.nameBySceneId[scene.id]);
    }
  });

  it.skipIf(!snapshot)("工厂演出的 scene_version 行数未被迁移带走", async () => {
    const { rows } = await getPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM scene_version WHERE version_id = $1",
      [snapshot!.versionId],
    );
    expect(parseInt(rows[0].count, 10)).toBe(Object.keys(snapshot!.numberBySceneId).length);
  });
});
