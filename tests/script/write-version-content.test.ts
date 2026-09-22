/**
 * writeVersionContent（测试 / 修复专用批量写原语）行为用例，兼作 #635 的护栏：
 *   A. 块新增 / 就地更新 / 物理删除、角色 upsert / 删除
 *   B. 收尾走 finalizeMarkerInvariantsInTx——场次派生行、归属回填、revision bump 与 patch 路径一致
 *   C. 同构断言：同一份内容经 writeVersionContent 与 applyPatchToDB 落库，核心表逐行相等
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/pg";
import { writeVersionContent, type SnapshotDbBlock } from "@/lib/script/script-version-content-db";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { initialKeys } from "@/lib/lex-order";
import type { Block } from "@/lib/script/script-types";
import { makeProduction, cleanupProduction } from "../_support/factories";

const db = () => getPool();

function marker(id: string, type: "chapter_marker" | "scene_marker", name: string, parentMarkerId: string | null = null): Block {
  return { id, type, content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null, markerMeta: { name, parentMarkerId } };
}
function dialogue(id: string, content: string, characterIds: string[] = [], annotations: Record<string, string> = {}): Block {
  return { id, type: "dialogue", content, characterIds, characterAnnotations: annotations, lyric: false, sceneId: null, rehearsalMark: null };
}
function newBlock(block: Block, lexKey: string): SnapshotDbBlock {
  return { ...block, lexKey, snapshotId: `sn_new_${block.id}` };
}
const emptyWrite = { upsertBlocks: [], deleteSnapshotIds: [], upsertChars: [], deleteCharIds: [] };

type Projection = {
  blocks: Array<{ block_id: string; type: string; content: string; scene_id: string | null; rehearsal_mark: string | null; owner_marker_id: string | null; marker_meta: unknown; chars: string }>;
  scenes: Array<{ scene_id: string; name: string; parent_id: string | null; sort_order: number }>;
  chars: Array<{ character_id: string; name: string; is_aggregate: boolean }>;
  revision: string;
};

/** 忽略 snapshot id / sort_key / 时间戳，按 block_id 顺序投影四张表 */
async function project(versionId: string): Promise<Projection> {
  const blocks = await db().query<Projection["blocks"][number]>(
    `SELECT sv.block_id, s.type::text AS type, s.content, s.scene_id, s.rehearsal_mark, s.owner_marker_id, s.marker_meta,
            COALESCE((SELECT string_agg(sc.character_id || ':' || COALESCE(sc.annotation, ''), ',' ORDER BY sc.position)
                      FROM script_character sc WHERE sc.script_id = s.id), '') AS chars
     FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
     WHERE sv.version_id = $1 ORDER BY sv.sort_key`, [versionId]);
  const scenes = await db().query<Projection["scenes"][number]>(
    "SELECT scene_id, name, parent_id, sort_order FROM scene_version WHERE version_id = $1 ORDER BY sort_order", [versionId]);
  const chars = await db().query<Projection["chars"][number]>(
    "SELECT character_id, name, is_aggregate FROM character_version WHERE version_id = $1 ORDER BY sort_order, character_id", [versionId]);
  const rev = await db().query<{ marker_structure_revision: string }>(
    "SELECT marker_structure_revision::text FROM version WHERE id = $1", [versionId]);
  return { blocks: blocks.rows, scenes: scenes.rows, chars: chars.rows, revision: rev.rows[0].marker_structure_revision };
}

describe("A: 块与角色的批量写", () => {
  let prodId: string;
  let versionId: string;
  const charId = randomUUID();
  const b1 = randomUUID();
  const b2 = randomUUID();
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("sn_new_ 前缀的块新插，角色 upsert", async () => {
    ({ prodId, versionId } = await makeProduction());
    const [k1, k2] = initialKeys(2);
    await writeVersionContent(prodId, versionId, {
      ...emptyWrite,
      upsertBlocks: [newBlock(dialogue(b1, "甲", [charId], { [charId]: "旁白" }), k1), newBlock(dialogue(b2, "乙"), k2)],
      upsertChars: [{ id: charId, name: "角色A", isAggregate: false, sortOrder: 0 }],
    });
    const p = await project(versionId);
    expect(p.blocks.map((b) => [b.block_id, b.content, b.chars])).toEqual([[b1, "甲", `${charId}:旁白`], [b2, "乙", ""]]);
    expect(p.chars).toEqual([{ character_id: charId, name: "角色A", is_aggregate: false }]);
  });

  it("已有 snapshot 就地更新（id 不变），角色关联整换", async () => {
    const before = await db().query<{ snapshot_id: string; sort_key: string }>(
      "SELECT snapshot_id, sort_key FROM script_version WHERE version_id = $1 AND block_id = $2", [versionId, b1]);
    await writeVersionContent(prodId, versionId, {
      ...emptyWrite,
      upsertBlocks: [{ ...dialogue(b1, "甲改"), lexKey: before.rows[0].sort_key, snapshotId: before.rows[0].snapshot_id }],
    });
    const after = await db().query<{ snapshot_id: string; content: string; chars: string }>(
      `SELECT sv.snapshot_id, s.content, (SELECT COUNT(*)::text FROM script_character sc WHERE sc.script_id = s.id) AS chars
       FROM script_version sv JOIN script s ON s.id = sv.snapshot_id WHERE sv.version_id = $1 AND sv.block_id = $2`, [versionId, b1]);
    expect(after.rows[0]).toEqual({ snapshot_id: before.rows[0].snapshot_id, content: "甲改", chars: "0" });
  });

  it("deleteSnapshotIds 物理删 snapshot；deleteCharIds 只删版本行、identity 行留作锚", async () => {
    const sid = (await db().query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM script_version WHERE version_id = $1 AND block_id = $2", [versionId, b2])).rows[0].snapshot_id;
    await writeVersionContent(prodId, versionId, { ...emptyWrite, deleteSnapshotIds: [sid], deleteCharIds: [charId] });
    expect((await db().query("SELECT 1 FROM script WHERE id = $1", [sid])).rowCount).toBe(0);
    expect((await db().query("SELECT 1 FROM character_version WHERE character_id = $1", [charId])).rowCount).toBe(0);
    expect((await db().query("SELECT 1 FROM character WHERE id = $1", [charId])).rowCount).toBe(1);
  });
});

describe("B: 收尾与 patch 路径同一套——场次派生行、归属回填、revision", () => {
  let prodId: string;
  let versionId: string;
  afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

  it("批量写入章 / 场标记后 scene_version 派生出来、正文块归属回填、revision bump 一次", async () => {
    ({ prodId, versionId } = await makeProduction());
    const chapter = randomUUID();
    const scene = randomUUID();
    const line = randomUUID();
    const [k1, k2, k3] = initialKeys(3);
    await writeVersionContent(prodId, versionId, {
      ...emptyWrite,
      // 故意不填 parentMarkerId / sceneId / ownerMarkerId，看收尾能不能补齐
      upsertBlocks: [newBlock(marker(chapter, "chapter_marker", "第一幕"), k1), newBlock(marker(scene, "scene_marker", "第一场"), k2), newBlock(dialogue(line, "台词"), k3)],
    });
    const p = await project(versionId);
    expect(p.scenes).toEqual([
      { scene_id: chapter, name: "第一幕", parent_id: null, sort_order: 0 },
      { scene_id: scene, name: "第一场", parent_id: chapter, sort_order: 1 },
    ]);
    const lineRow = p.blocks.find((b) => b.block_id === line)!;
    expect(lineRow.scene_id).toBe(scene);
    expect(lineRow.owner_marker_id).toBe(scene);
    expect((p.blocks.find((b) => b.block_id === scene)!.marker_meta as { parentMarkerId: string }).parentMarkerId).toBe(chapter);
    expect(p.revision).toBe("1");
  });

  it("只改正文内容不动结构：revision 不变", async () => {
    const row = (await db().query<{ snapshot_id: string; block_id: string; sort_key: string }>(
      `SELECT sv.snapshot_id, sv.block_id, sv.sort_key FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND s.type = 'dialogue'`, [versionId])).rows[0];
    await writeVersionContent(prodId, versionId, {
      ...emptyWrite,
      upsertBlocks: [{ ...dialogue(row.block_id, "台词改"), lexKey: row.sort_key, snapshotId: row.snapshot_id }],
    });
    expect((await project(versionId)).revision).toBe("1");
  });

  it("修复场景：库里归属列被手改坏，任意一次块写入的收尾把它归一回来", async () => {
    const line = (await db().query<{ snapshot_id: string; block_id: string; sort_key: string }>(
      `SELECT sv.snapshot_id, sv.block_id, sv.sort_key FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
       WHERE sv.version_id = $1 AND s.type = 'dialogue'`, [versionId])).rows[0];
    await db().query("UPDATE script SET owner_marker_id = NULL, scene_id = NULL WHERE id = $1", [line.snapshot_id]);
    // 只动另一个块（新插一句），不碰坏掉的那行——收尾的整版归一化才是修它的人
    const extra = randomUUID();
    await writeVersionContent(prodId, versionId, {
      ...emptyWrite,
      upsertBlocks: [newBlock(dialogue(extra, "又一句"), `${line.sort_key}V`)],
    });
    const fixed = (await project(versionId)).blocks.find((b) => b.block_id === line.block_id)!;
    expect(fixed.owner_marker_id).not.toBeNull();
    expect(fixed.scene_id).toBe(fixed.owner_marker_id);
  });
});

describe("C: 同构断言——同一份内容经两条写路径落库，核心表逐行相等", () => {
  let prodA: string;
  let prodB: string;
  afterAll(async () => {
    await cleanupProduction(prodA).catch(() => {});
    await cleanupProduction(prodB).catch(() => {});
  });

  it("writeVersionContent 整批 vs applyPatchToDB 逐 op：块 / 场次 / 角色 / revision 投影相等", async () => {
    const chapter = randomUUID();
    const scene1 = randomUUID();
    const scene2 = randomUUID();
    const l1 = randomUUID();
    const l2 = randomUUID();
    const l3 = randomUUID();
    const charA = randomUUID();
    const charB = randomUUID();
    const blocks: Block[] = [
      marker(chapter, "chapter_marker", "序幕"),
      marker(scene1, "scene_marker", "一"),
      dialogue(l1, "第一句", [charA]),
      dialogue(l2, "第二句", [charA, charB], { [charB]: "画外音" }),
      marker(scene2, "scene_marker", "二"),
      dialogue(l3, "第三句"),
    ];
    const chars = [{ id: charA, name: "甲", isAggregate: false }, { id: charB, name: "乙", isAggregate: false }];

    const a = await makeProduction();
    prodA = a.prodId;
    const keys = initialKeys(blocks.length);
    await writeVersionContent(prodA, a.versionId, {
      ...emptyWrite,
      upsertBlocks: blocks.map((b, i) => newBlock(b, keys[i])),
      upsertChars: chars.map((c, i) => ({ ...c, sortOrder: i })),
    });

    const b = await makeProduction();
    prodB = b.prodId;
    await applyPatchToDB(prodB, b.versionId, {
      clientSeq: 1, blockOps: [], sceneOps: [],
      charOps: chars.map((c) => ({ op: "upsert" as const, char: c })),
    });
    // 一个 patch 装下全部 insert：逐 patch 插的话，空场次会在中途被补占位块（#637），
    // 那是 op 序列的产物不是写路径的分叉
    await applyPatchToDB(prodB, b.versionId, {
      clientSeq: 1, charOps: [], sceneOps: [],
      blockOps: blocks.map((block, i) => ({ op: "insert" as const, block, afterId: i === 0 ? null : blocks[i - 1].id })),
    });

    const pa = await project(a.versionId);
    const pb = await project(b.versionId);
    expect(pa.blocks).toEqual(pb.blocks);
    expect(pa.scenes).toEqual(pb.scenes);
    expect(pa.chars).toEqual(pb.chars);
    expect(pa.revision).toBe(pb.revision);
  });
});
