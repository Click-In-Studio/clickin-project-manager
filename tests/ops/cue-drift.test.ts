/**
 * cue 锚点漂移的两处护栏（#655）：
 *  1. 读侧：锚点 snapshot 已不在 script 表时，gap 锚点保留悬空 id 而不是折叠成 null
 *     （null 是「第一块之前」的合法值，折叠进去前端既不渲染也判不出失效）。
 *  2. 写侧：一批连删相邻块时，cue 只能重锚到**同批不删**的邻居；两条删块路径
 *     （applyPatchToDB / writeVersionContent）同一条理由。
 */
import { describe, it, expect, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { writeVersionContent } from "@/lib/script/script-version-content-db";
import { createCueList } from "@/lib/ops/cue-list-db";
import { createCue, getCue, listCueWarningsForUser } from "@/lib/ops/cue-db";
import { TEST_USER } from "../_support/helpers";
import { makeProduction, makeBlocks, cleanupProduction, shortId } from "../_support/factories";

const prodIds: string[] = [];

afterAll(async () => {
  await Promise.all(prodIds.map((id) => cleanupProduction(id).catch(() => {})));
});

async function setup(blockCount: number) {
  const { prodId, versionId } = await makeProduction();
  prodIds.push(prodId);
  const blockIds = await makeBlocks(prodId, versionId, blockCount);
  const res = await getPool().query<{ block_id: string; snapshot_id: string }>(
    "SELECT block_id, snapshot_id FROM script_version WHERE version_id = $1",
    [versionId],
  );
  const snapshotByBlock = new Map(res.rows.map((r) => [r.block_id, r.snapshot_id]));
  const listId = `cl-${shortId()}`;
  await createCueList({
    id: listId, productionId: prodId, name: "漂移护栏", notes: "", abbr: "DR",
    template: null, createdBy: TEST_USER,
  });
  return { prodId, versionId, blockIds, snapshotByBlock, listId };
}

async function makeGapCue(listId: string, versionId: string, afterBlockId: string) {
  const cueId = `cue-${shortId()}`;
  const anchor = { kind: "gap" as const, afterBlockId };
  await createCue({ id: cueId, cueListId: listId, number: "Q1", name: "护栏", content: "", start: anchor, end: anchor, versionId });
  return cueId;
}

describe("读侧：锚点 snapshot 消失后 gap 锚点保留悬空 id（#655）", () => {
  it("script 行被直接删掉时 afterBlockId 是悬空的 snapshot id，不是 null", async () => {
    const { versionId, blockIds, snapshotByBlock, listId } = await setup(2);
    const cueId = await makeGapCue(listId, versionId, blockIds[1]);
    const deadSnapshot = snapshotByBlock.get(blockIds[1])!;

    // 绕过漂移钩子直接删 snapshot 行，复现线上 7 条悬空 cue 的库态
    await getPool().query("DELETE FROM script WHERE id = $1", [deadSnapshot]);

    const cue = (await getCue(cueId, listId))!;
    expect(cue.start.kind).toBe("gap");
    expect(cue.start.kind === "gap" && cue.start.afterBlockId).toBe(deadSnapshot);
    expect(cue.end.kind === "gap" && cue.end.afterBlockId).toBe(deadSnapshot);
  });
});

describe("写侧：连删相邻块时 cue 只重锚到同批存活的邻居（#655）", () => {
  it("applyPatchToDB 一批删 B2、B3：锚在 B3 后的 cue 落到 B1 之后", async () => {
    const { prodId, versionId, blockIds, listId } = await setup(4);
    const [b1, b2, b3] = blockIds;
    const cueId = await makeGapCue(listId, versionId, b3);

    await applyPatchToDB(prodId, versionId, {
      clientSeq: 1,
      blockOps: [{ op: "delete", id: b2 }, { op: "delete", id: b3 }],
      charOps: [], sceneOps: [],
    });

    const cue = (await getCue(cueId, listId))!;
    expect(cue.warning).toBe(true);
    expect(cue.start).toEqual({ kind: "gap", afterBlockId: b1 });
    expect(cue.end).toEqual({ kind: "gap", afterBlockId: b1 });
  });

  it("applyPatchToDB 删掉最前两个台词块：锚在 B2 后的 cue 落到仍存在的块上（场景标记或 B3）", async () => {
    const { prodId, versionId, blockIds, listId } = await setup(3);
    const [b1, b2] = blockIds;
    const cueId = await makeGapCue(listId, versionId, b2);

    await applyPatchToDB(prodId, versionId, {
      clientSeq: 1,
      blockOps: [{ op: "delete", id: b1 }, { op: "delete", id: b2 }],
      charOps: [], sceneOps: [],
    });

    // 版本里除台词块外还有场景标记块，删到最前时邻居可能是标记：只断言锚到的是存活块
    const survivors = new Set(
      (await getPool().query<{ block_id: string }>(
        "SELECT block_id FROM script_version WHERE version_id = $1", [versionId],
      )).rows.map((r) => r.block_id),
    );
    expect(survivors.has(b1) || survivors.has(b2)).toBe(false);
    const cue = (await getCue(cueId, listId))!;
    const anchored = cue.start.kind === "gap" ? cue.start.afterBlockId : cue.start.blockId;
    expect(anchored).not.toBeNull();
    expect(survivors.has(anchored!)).toBe(true);
  });

  it("applyPatchToDB 同批删 B2 并改 B1 内容：cue 落到 B1 之后且 B1 的 snapshot 就地不换", async () => {
    // AI review 关切：重锚目标若在同批被 update、换了 snapshot，会再次悬空。#634 后 update
    // 就地改写不换 snapshot，这条用例把「删 + 改同批」的组合钉住。
    const { prodId, versionId, blockIds, snapshotByBlock, listId } = await setup(3);
    const [b1, b2] = blockIds;
    const cueId = await makeGapCue(listId, versionId, b2);

    await applyPatchToDB(prodId, versionId, {
      clientSeq: 1,
      blockOps: [
        { op: "delete", id: b2 },
        { op: "update", block: {
          id: b1, type: "dialogue", content: "同批改写的 B1", characterIds: [],
          characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null,
        } },
      ],
      charOps: [], sceneOps: [],
    });

    const b1Snapshot = await getPool().query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM script_version WHERE version_id = $1 AND block_id = $2", [versionId, b1],
    );
    expect(b1Snapshot.rows[0]?.snapshot_id).toBe(snapshotByBlock.get(b1));
    const cue = (await getCue(cueId, listId))!;
    expect(cue.warning).toBe(true);
    expect(cue.start).toEqual({ kind: "gap", afterBlockId: b1 });

    // 跨项目告警条目带稳定 cue_id（公告页深链接用），成员口径按 production_member
    await getPool().query(
      "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
      [prodId, TEST_USER],
    );
    const entry = (await listCueWarningsForUser(TEST_USER, false)).find((e) => e.cueListId === listId);
    expect(entry).toMatchObject({ cueId, cueListId: listId, productionId: prodId, warningType: "orphaned" });
  });

  it("writeVersionContent 一批删 B2、B3：锚在 B3 后的 cue 落到 B1 之后", async () => {
    const { prodId, versionId, blockIds, snapshotByBlock, listId } = await setup(4);
    const [b1, b2, b3] = blockIds;
    const cueId = await makeGapCue(listId, versionId, b3);

    await writeVersionContent(prodId, versionId, {
      upsertBlocks: [],
      deleteSnapshotIds: [snapshotByBlock.get(b2)!, snapshotByBlock.get(b3)!],
      upsertChars: [], deleteCharIds: [],
    });

    const cue = (await getCue(cueId, listId))!;
    expect(cue.warning).toBe(true);
    expect(cue.start).toEqual({ kind: "gap", afterBlockId: b1 });
  });
});
