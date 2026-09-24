/**
 * 整版写路径的标记结构修复护栏（#637）：「标记之后至少一个正文块」等不变量只在
 * script-marker-domain 判一份，导入 / 批量写在收尾 finalizeMarkerInvariantsInTx 整版跑它——
 * 此前导入自带一份 SQL 扫描（只在联合导入带场次映射时开）、批量写完全不维护。
 *   A. importScriptToVersion：空场次补占位正文块并归属该场；有正文 / 紧跟子场的不补
 *   B. 场次后紧跟排练标记再到下一场：占位块落在排练标记之后（此前 SQL 扫描落在两者之间）
 *   C. writeVersionContent：同一套规则
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/pg";
import { importScriptToVersion } from "@/lib/script/script-import-db";
import { writeVersionContent, type SnapshotDbBlock } from "@/lib/script/script-version-content-db";
import { initialKeys } from "@/lib/lex-order";
import type { Block } from "@/lib/script/script-types";
import { makeProduction, cleanupProduction } from "../_support/factories";

type Row = { block_id: string; type: string; content: string; scene_id: string | null; owner_marker_id: string | null };

async function rows(versionId: string): Promise<Row[]> {
  const r = await getPool().query<Row>(
    `SELECT sv.block_id, s.type::text AS type, s.content, s.scene_id, s.owner_marker_id
     FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
     WHERE sv.version_id = $1 ORDER BY sv.sort_key`,
    [versionId],
  );
  return r.rows;
}

/** 紧跟在 markerId 之后、直到下一枚标记为止的块 */
function segmentAfter(all: Row[], markerId: string): Row[] {
  const start = all.findIndex((row) => row.block_id === markerId);
  const out: Row[] = [];
  for (let i = start + 1; i < all.length; i++) {
    if (all[i].type.endsWith("_marker")) break;
    out.push(all[i]);
  }
  return out;
}

function marker(id: string, type: Block["type"], name: string, parentMarkerId: string | null): Block {
  return {
    id, type, content: "", characterIds: [], characterAnnotations: {}, lyric: false,
    sceneId: type === "rehearsal_marker" ? null : id, rehearsalMark: null,
    markerMeta: { name, parentMarkerId },
  };
}
function dialogue(id: string, content: string): Block {
  return { id, type: "dialogue", content, characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null };
}
function importBlock(block: Block, lexKey: string) {
  return { ...block, id: `sn_${block.id}`, blockId: block.id, characterIds: [], characterAnnotations: {}, lexKey };
}

describe("A: 导入——空场次补占位正文块", () => {
  let prodId: string;
  let versionId: string;
  const ids = {
    chapter: `ch_${randomUUID()}`, sceneWithText: `sc_${randomUUID()}`, text: `b_${randomUUID()}`,
    emptyScene: `sc_${randomUUID()}`, chapter2: `ch_${randomUUID()}`, emptyScene2: `sc_${randomUUID()}`,
    scene3: `sc_${randomUUID()}`, text3: `b_${randomUUID()}`,
  };
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("每枚没有正文的场次后面恰有一个空 dialogue 块，归属该场", async () => {
    ({ prodId, versionId } = await makeProduction());
    const seq: Block[] = [
      marker(ids.chapter, "chapter_marker", "第一幕", null),
      marker(ids.sceneWithText, "scene_marker", "有词的场", ids.chapter),
      dialogue(ids.text, "台词"),
      marker(ids.emptyScene, "scene_marker", "空场", ids.chapter),
      marker(ids.chapter2, "chapter_marker", "第二幕", null),
      marker(ids.emptyScene2, "scene_marker", "空场二", ids.chapter2),
      marker(ids.scene3, "scene_marker", "末场", ids.chapter2),
      dialogue(ids.text3, "尾词"),
    ];
    const keys = initialKeys(seq.length);
    // 不带 sceneOverrides / 任何开关：导入路径一律维护不变量
    await importScriptToVersion(prodId, versionId, {
      upsertBlocks: seq.map((block, i) => importBlock(block, keys[i])),
      upsertChars: [],
      upsertScenes: [],
    });
    const all = await rows(versionId);
    expect(all.map((r) => r.type)).toEqual([
      "chapter_marker", "scene_marker", "dialogue", "scene_marker", "dialogue",
      "chapter_marker", "scene_marker", "dialogue", "scene_marker", "dialogue",
    ]);
    for (const emptyScene of [ids.emptyScene, ids.emptyScene2]) {
      const seg = segmentAfter(all, emptyScene);
      expect(seg).toHaveLength(1);
      expect(seg[0]).toMatchObject({ type: "dialogue", content: "", scene_id: emptyScene, owner_marker_id: emptyScene });
    }
    // 有正文的场次与紧跟子场的章不补
    expect(segmentAfter(all, ids.sceneWithText).map((r) => r.block_id)).toEqual([ids.text]);
    expect(segmentAfter(all, ids.scene3).map((r) => r.block_id)).toEqual([ids.text3]);
    expect(segmentAfter(all, ids.chapter)).toHaveLength(0);
    expect(segmentAfter(all, ids.chapter2)).toHaveLength(0);
  });

  it("重新导入同一序列仍恰好一枚占位（整版替换后重新派生，不累积）", async () => {
    const seq: Block[] = [
      marker(ids.chapter, "chapter_marker", "第一幕", null),
      marker(ids.emptyScene, "scene_marker", "空场", ids.chapter),
    ];
    const keys = initialKeys(seq.length);
    await importScriptToVersion(prodId, versionId, { upsertBlocks: seq.map((b, i) => importBlock(b, keys[i])), upsertChars: [], upsertScenes: [] });
    await importScriptToVersion(prodId, versionId, { upsertBlocks: seq.map((b, i) => importBlock(b, keys[i])), upsertChars: [], upsertScenes: [] });
    const all = await rows(versionId);
    expect(all.map((r) => r.type)).toEqual(["chapter_marker", "scene_marker", "dialogue"]);
    expect(all[2]).toMatchObject({ content: "", owner_marker_id: ids.emptyScene });
  });
});

describe("B: 场次后紧跟排练标记——占位块落在排练标记之后", () => {
  let prodId: string;
  let versionId: string;
  const chapter = `ch_${randomUUID()}`;
  const scene = `sc_${randomUUID()}`;
  const rehearsal = `rh_${randomUUID()}`;
  const nextScene = `sc_${randomUUID()}`;
  const text = `b_${randomUUID()}`;
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("场次与排练标记之间不插，排练标记与下一场之间插一枚，归属排练标记", async () => {
    ({ prodId, versionId } = await makeProduction());
    const seq: Block[] = [
      marker(chapter, "chapter_marker", "第一幕", null),
      marker(scene, "scene_marker", "一场", chapter),
      marker(rehearsal, "rehearsal_marker", "A", scene),
      marker(nextScene, "scene_marker", "二场", chapter),
      dialogue(text, "台词"),
    ];
    const keys = initialKeys(seq.length);
    await importScriptToVersion(prodId, versionId, { upsertBlocks: seq.map((b, i) => importBlock(b, keys[i])), upsertChars: [], upsertScenes: [] });
    const all = await rows(versionId);
    expect(all.map((r) => r.block_id === text ? "text" : r.type)).toEqual([
      "chapter_marker", "scene_marker", "rehearsal_marker", "dialogue", "scene_marker", "text",
    ]);
    expect(all[3]).toMatchObject({ content: "", scene_id: scene, owner_marker_id: rehearsal });
  });
});

describe("C: writeVersionContent 同一套规则", () => {
  let prodId: string;
  let versionId: string;
  const chapter = `ch_${randomUUID()}`;
  const emptyScene = `sc_${randomUUID()}`;
  const scene2 = `sc_${randomUUID()}`;
  const text = `b_${randomUUID()}`;
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("空场次后补占位块，其余不动", async () => {
    ({ prodId, versionId } = await makeProduction());
    const seq: Block[] = [
      marker(chapter, "chapter_marker", "第一幕", null),
      marker(emptyScene, "scene_marker", "空场", chapter),
      marker(scene2, "scene_marker", "二场", chapter),
      dialogue(text, "台词"),
    ];
    const keys = initialKeys(seq.length);
    const upsertBlocks: SnapshotDbBlock[] = seq.map((b, i) => ({ ...b, lexKey: keys[i], snapshotId: `sn_new_${b.id}` }));
    await writeVersionContent(prodId, versionId, { upsertBlocks, deleteSnapshotIds: [], upsertChars: [], deleteCharIds: [] });
    const all = await rows(versionId);
    expect(all.map((r) => r.block_id === text ? "text" : r.type)).toEqual([
      "chapter_marker", "scene_marker", "dialogue", "scene_marker", "text",
    ]);
    expect(all[2]).toMatchObject({ content: "", scene_id: emptyScene, owner_marker_id: emptyScene });
  });
});
