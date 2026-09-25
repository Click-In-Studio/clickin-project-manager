import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { makeProduction, cleanupProduction, makeScene } from "../_support/factories";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { loadProduction } from "@/lib/script/script-state-db";
import { diffState, type ScriptPatch } from "@/lib/script/script-ops";
import { initialKeys, keyBetween, keyStrictlyBetween } from "@/lib/lex-order";
import { getPool } from "@/lib/pg";
import type { Block, ScriptState } from "@/lib/script/script-types";

// #680：定宽 base36 的 sort_key 每次取中，同一间隙同侧连续插入约 45 次即耗尽。
// 此前耗尽后 keyBetween 返回与锚点相同的 key，ORDER BY sort_key 对同 key 行顺序不定——
// AI 批量插入的块散落、跨到下一段标记之后（线上剧本第一幕 117 块被打乱）。
// 修复：分配 key 发现无空位时整版重铺后再取（allocateInsertKeyInTx）。

let prodId: string;
let versionId: string;
let chA: string;
let chB: string;

const textBlock = (content: string): Block => ({
  id: randomUUID(), type: "stage", content,
  characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null,
});

const insertPatch = (block: Block, afterId: string): ScriptPatch =>
  ({ clientSeq: 1, blockOps: [{ op: "insert", block, afterId }], charOps: [], sceneOps: [] });

async function orderedIds(): Promise<string[]> {
  return (await loadProduction(prodId, versionId))!.state.blocks.map((b) => b.id);
}

async function dbKeyStats(): Promise<{ total: number; distinct: number }> {
  const res = await getPool().query<{ total: string; distinct: string }>(
    "SELECT count(*) AS total, count(DISTINCT sort_key) AS distinct FROM script_version WHERE version_id = $1",
    [versionId]);
  return { total: Number(res.rows[0].total), distinct: Number(res.rows[0].distinct) };
}

async function storedOwners(blockIds: string[]): Promise<Set<string | null>> {
  const res = await getPool().query<{ owner_marker_id: string | null }>(
    `SELECT s.owner_marker_id FROM script s JOIN script_version sv ON sv.snapshot_id = s.id
     WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[])`, [versionId, blockIds]);
  return new Set(res.rows.map((r) => r.owner_marker_id));
}

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  const first = await makeScene(prodId, versionId, { name: "甲" });
  const second = await makeScene(prodId, versionId, { name: "乙" });
  // 工厂的落位不作假设：按读回的文档顺序认前后
  const ids = await orderedIds();
  [chA, chB] = ids.indexOf(first) < ids.indexOf(second) ? [first, second] : [second, first];
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("lex-order：严格取中", () => {
  it("间隙耗尽时 keyStrictlyBetween 给 null，而 keyBetween 会退回锚点自身的 key（旧行为即 #680 根因）", () => {
    const [lo, hi] = initialKeys(2);
    let cursor = lo;
    let exhaustedAt = -1;
    for (let i = 1; i <= 80; i++) {
      const next = keyStrictlyBetween(cursor, hi);
      if (next === null) { exhaustedAt = i; break; }
      expect(next > cursor && next < hi).toBe(true);
      cursor = next;
    }
    expect(exhaustedAt).toBeGreaterThan(0);
    expect(exhaustedAt).toBeLessThan(60);
    expect(keyBetween(cursor, hi)).toBe(cursor);
    expect(keyStrictlyBetween(null, null)).not.toBeNull();
    expect(keyStrictlyBetween(null, "0000000000")).toBeNull();
    expect(keyStrictlyBetween("zzzzzzzzzz", null)).toBeNull();
  });
});

describe("applyPatchToDB：间隙耗尽自动重铺（#680）", () => {
  it("逐批追加到段尾 70 次：顺序与插入序一致、key 唯一、归属仍在本段", async () => {
    const ids: string[] = [];
    let anchor = chA;
    for (let i = 0; i < 70; i++) {
      const block = textBlock(`段尾 ${i}`);
      await applyPatchToDB(prodId, versionId, insertPatch(block, anchor));
      ids.push(block.id);
      anchor = block.id;
    }
    const order = await orderedIds();
    expect(order.slice(order.indexOf(chA) + 1, order.indexOf(chB))).toEqual(ids);
    const stats = await dbKeyStats();
    expect(stats.distinct).toBe(stats.total);
    expect(await storedOwners(ids)).toEqual(new Set([chA]));
  });

  it("一批 60 块链式插入（diffState 产出的 insert 链）：整批各就各位", async () => {
    const prev = (await loadProduction(prodId, versionId))!.state;
    const at = prev.blocks.findIndex((b) => b.id === chB);
    const fresh = Array.from({ length: 60 }, (_, i) => textBlock(`一批 ${i}`));
    const next: ScriptState = { ...prev, blocks: [...prev.blocks.slice(0, at), ...fresh, ...prev.blocks.slice(at)] };
    await applyPatchToDB(prodId, versionId, { ...diffState(prev, next, 0), clientSeq: 0 });
    const order = await orderedIds();
    const freshIds = fresh.map((b) => b.id);
    expect(order.slice(order.indexOf(chB) - 60, order.indexOf(chB))).toEqual(freshIds);
    const stats = await dbKeyStats();
    expect(stats.distinct).toBe(stats.total);
    expect(await storedOwners(freshIds)).toEqual(new Set([chA]));
  });

  it("文末追加 60 次（无上界）同样不撞 key", async () => {
    const ids: string[] = [];
    let anchor = chB;
    for (let i = 0; i < 60; i++) {
      const block = textBlock(`文末 ${i}`);
      await applyPatchToDB(prodId, versionId, insertPatch(block, anchor));
      ids.push(block.id);
      anchor = block.id;
    }
    const order = await orderedIds();
    // 标记不变量修复可能在文末补块，只断言这 60 块连续且有序
    const start = order.indexOf(ids[0]);
    expect(order.slice(start, start + 60)).toEqual(ids);
    const stats = await dbKeyStats();
    expect(stats.distinct).toBe(stats.total);
    expect(await storedOwners(ids)).toEqual(new Set([chB]));
  });
});
