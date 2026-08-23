/**
 * 线性历史完整性测试（版本退役 Phase B 后）：
 * CoW on blocks and cues（遗留多版本共享态的只读保护）、GC、并发。
 *
 * 分支（createVersion）与 rollback 已退役——多版本共享态只能来自遗留数据，
 * 测试用 makeLegacyVersion 工厂（裸 SQL）模拟。
 * Each describe block uses its own isolated production to avoid cross-test contamination.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Block } from "@/lib/script-types";
import type { ScriptPatch } from "@/lib/script-ops";
import {
  createProduction, deleteProduction,
  getActiveVersionId, getVersion,
  applyPatchToDB,
  cowBlockSnapshotForMount,
  createCueList, createCue, updateCue, deleteCue,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { TEST_USER, TEST_OWNER } from "./helpers";
import { makeLegacyVersion } from "./factories";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const mkBlock = (id: string, content: string): Block => ({
  id, type: "dialogue", content,
  characterIds: [], characterAnnotations: {},
  lyric: false, sceneId: null, rehearsalMark: null,
});

const ins = (block: Block, afterId: string | null = null): ScriptPatch => ({
  clientSeq: 1, blockOps: [{ op: "insert", block, afterId }], charOps: [], sceneOps: [],
});
const upd = (block: Block): ScriptPatch => ({
  clientSeq: 2, blockOps: [{ op: "update", block }], charOps: [], sceneOps: [],
});
const del = (id: string): ScriptPatch => ({
  clientSeq: 3, blockOps: [{ op: "delete", id }], charOps: [], sceneOps: [],
});

const db = () => getPool();

// script_version lookups
async function snapshotId(versionId: string, blockId: string): Promise<string | null> {
  const r = await db().query<{ snapshot_id: string }>(
    "SELECT snapshot_id FROM script_version WHERE version_id=$1 AND block_id=$2",
    [versionId, blockId],
  );
  return r.rows[0]?.snapshot_id ?? null;
}

async function snapshotContent(sid: string): Promise<string | null> {
  const r = await db().query<{ content: string }>("SELECT content FROM script WHERE id=$1", [sid]);
  return r.rows[0]?.content ?? null;
}

async function snapshotRefCount(sid: string): Promise<number> {
  const r = await db().query<{ cnt: string }>(
    "SELECT COUNT(*) AS cnt FROM script_version WHERE snapshot_id=$1", [sid],
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function physicalSnapshotExists(sid: string): Promise<boolean> {
  const r = await db().query<{ e: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM script WHERE id=$1) AS e", [sid],
  );
  return r.rows[0].e;
}

// cue_version lookups
async function cueRevisionId(versionId: string, logicalCueId: string): Promise<string | null> {
  const r = await db().query<{ revision_id: string }>(
    "SELECT revision_id FROM cue_version WHERE version_id=$1 AND cue_id=$2",
    [versionId, logicalCueId],
  );
  return r.rows[0]?.revision_id ?? null;
}

async function cueName(revisionId: string): Promise<string | null> {
  const r = await db().query<{ name: string }>("SELECT name FROM cue WHERE id=$1", [revisionId]);
  return r.rows[0]?.name ?? null;
}

async function cueRevRefCount(revisionId: string): Promise<number> {
  const r = await db().query<{ cnt: string }>(
    "SELECT COUNT(*) AS cnt FROM cue_version WHERE revision_id=$1", [revisionId],
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function physicalCueExists(revisionId: string): Promise<boolean> {
  const r = await db().query<{ e: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM cue WHERE id=$1) AS e", [revisionId],
  );
  return r.rows[0].e;
}

// Convenience: create a minimal cue list
async function mkCueList(prod: string, clId: string): Promise<void> {
  await createCueList({
    id: clId, productionId: prod, name: "测试走位表",
    notes: "", abbr: null, template: null, createdBy: TEST_USER,
  });
}

// Convenience: create a gap-anchored cue bound to a version
async function mkCue(id: string, clId: string, name: string, versionId: string): Promise<void> {
  await createCue({
    id, cueListId: clId, number: id, name, content: "",
    start: { kind: "gap", afterBlockId: null },
    end:   { kind: "gap", afterBlockId: null },
    versionId,
  });
}

// ─── G1: makeLegacyVersion — 遗留共享态前提 ──────────────────────────────────

describe("makeLegacyVersion — 遗留多版本共享态", () => {
  const PROD = "test-vcs-legacy";
  const CL   = "vcs-cl-legacy";
  let v1Id: string;
  let v2Id: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "遗留共享态测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await mkCueList(PROD, CL);
    await applyPatchToDB(PROD, v1Id, ins(mkBlock("g1b1", "块一内容")));
    await mkCue("g1-cue1", CL, "首个走位", v1Id);
    v2Id = await makeLegacyVersion(PROD, v1Id);
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("新旧版本共享同一 snapshot_id（浅拷贝）", async () => {
    const s1 = await snapshotId(v1Id, "g1b1");
    const s2 = await snapshotId(v2Id, "g1b1");
    expect(s1).not.toBeNull();
    expect(s1).toBe(s2);
  });

  it("新旧版本共享 cue_version 条目，指向同一 revision_id", async () => {
    const r1 = await cueRevisionId(v1Id, "g1-cue1");
    const r2 = await cueRevisionId(v2Id, "g1-cue1");
    expect(r1).not.toBeNull();
    expect(r1).toBe(r2);
  });

  it("新版本成为活跃 head，血统指向旧版本", async () => {
    expect(await getActiveVersionId(PROD)).toBe(v2Id);
    expect((await getVersion(v2Id))?.parentVersionId).toBe(v1Id);
  });
});

// ─── G2: Block CoW (applyPatchToDB update path) ──────────────────────────────

describe("block CoW — applyPatchToDB 编辑路径", () => {
  const PROD = "test-vcs-block-cow";
  let v1Id: string;
  let v2Id: string;
  let origSnap: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "Block CoW 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await applyPatchToDB(PROD, v1Id, ins(mkBlock("bk1", "原始内容")));
    origSnap = (await snapshotId(v1Id, "bk1"))!;
    v2Id = await makeLegacyVersion(PROD, v1Id);
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("遗留共享后 snapshot 被两个版本共享（refCount = 2）", async () => {
    expect(await snapshotRefCount(origSnap)).toBe(2);
  });

  it("head 编辑共享 block → head 得到新 snapshot，历史版本保持旧 snapshot", async () => {
    await applyPatchToDB(PROD, v2Id, upd(mkBlock("bk1", "V2 改后内容")));
    const s1 = await snapshotId(v1Id, "bk1");
    const s2 = await snapshotId(v2Id, "bk1");
    expect(s1).toBe(origSnap);
    expect(s2).not.toBe(origSnap);
    expect(s2).not.toBeNull();
  });

  it("历史版本内容逐字节不变", async () => {
    expect(await snapshotContent(origSnap)).toBe("原始内容");
  });

  it("head 内容已更新为新值", async () => {
    const s2 = await snapshotId(v2Id, "bk1");
    expect(await snapshotContent(s2!)).toBe("V2 改后内容");
  });

  it("head 独占新 snapshot 后再次编辑 → 原地更新（同一 snapshot_id）", async () => {
    const s2Before = (await snapshotId(v2Id, "bk1"))!;
    expect(await snapshotRefCount(s2Before)).toBe(1);      // sole owner
    await applyPatchToDB(PROD, v2Id, upd(mkBlock("bk1", "V2 再改")));
    const s2After = await snapshotId(v2Id, "bk1");
    expect(s2After).toBe(s2Before);                         // same ID — in-place
    expect(await snapshotContent(s2After!)).toBe("V2 再改");
  });
});

// ─── G2b: Block CoW 只 remap 本版本 ──────────────────────────────────────────

describe("block CoW — 版本本地 remap，不波及其他共享版本", () => {
  const PROD = "test-vcs-block-nocasc";
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;
  let origSnap: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "Block 本地 remap 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await applyPatchToDB(PROD, v1Id, ins(mkBlock("bk2", "初始内容")));
    origSnap = (await snapshotId(v1Id, "bk2"))!;
    v2Id = await makeLegacyVersion(PROD, v1Id);
    v3Id = await makeLegacyVersion(PROD, v2Id);
    // v1/v2/v3 共享同一 snapshot，现在编辑 v2（遗留中间版本）
    await applyPatchToDB(PROD, v2Id, upd(mkBlock("bk2", "V2 修改")));
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("V2 编辑后 V1 仍持有旧 snapshot", async () => {
    expect(await snapshotId(v1Id, "bk2")).toBe(origSnap);
  });

  it("V2 编辑后 V3 仍持有旧 snapshot（CoW 只 remap 当前版本）", async () => {
    expect(await snapshotId(v3Id, "bk2")).toBe(origSnap);
  });

  it("V2 本身指向新 snapshot", async () => {
    const s2 = await snapshotId(v2Id, "bk2");
    expect(s2).not.toBe(origSnap);
    expect(await snapshotContent(s2!)).toBe("V2 修改");
  });
});

// ─── G3: Block GC ─────────────────────────────────────────────────────────────

describe("block GC — 删除时 NOT EXISTS 守护", () => {
  const PROD = "test-vcs-block-gc";
  let v1Id: string;
  let v2Id: string;
  let sharedSnap: string;
  let v2OnlySnap: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "Block GC 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await applyPatchToDB(PROD, v1Id, ins(mkBlock("bgc1", "GC 测试块")));
    sharedSnap = (await snapshotId(v1Id, "bgc1"))!;
    v2Id = await makeLegacyVersion(PROD, v1Id);
    // V2 专属 block：共享态形成之后插入，V1 不持有
    await applyPatchToDB(PROD, v2Id, ins(mkBlock("bgc2", "V2 专属块")));
    v2OnlySnap = (await snapshotId(v2Id, "bgc2"))!;
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("从 V2 删除共享 block：snapshot 物理行仍存在（V1 还持有）", async () => {
    await applyPatchToDB(PROD, v2Id, del("bgc1"));
    expect(await snapshotId(v2Id, "bgc1")).toBeNull();       // V2 no longer has the block
    expect(await physicalSnapshotExists(sharedSnap)).toBe(true); // but physical row survives
  });

  it("从 V1 再删除 block：snapshot 物理行被 GC", async () => {
    await applyPatchToDB(PROD, v1Id, del("bgc1"));
    expect(await physicalSnapshotExists(sharedSnap)).toBe(false);
  });

  it("V2 专属 block（V1 不持有）被删除后物理行被 GC", async () => {
    expect(await snapshotRefCount(v2OnlySnap)).toBe(1);      // sole owner
    await applyPatchToDB(PROD, v2Id, del("bgc2"));
    expect(await physicalSnapshotExists(v2OnlySnap)).toBe(false);
  });
});

// ─── G4: Cue CoW (updateCue) ─────────────────────────────────────────────────

describe("cue CoW — updateCue refCount 分支", () => {
  const PROD = "test-vcs-cue-cow";
  const CL   = "vcs-cl-cue-cow";
  let v1Id: string;
  let v2Id: string;
  let origRev: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "Cue CoW 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await mkCueList(PROD, CL);
    await mkCue("g4-cue1", CL, "原始名", v1Id);
    v2Id = await makeLegacyVersion(PROD, v1Id);
    origRev = (await cueRevisionId(v1Id, "g4-cue1"))!;
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("refCount = 2：updateCue CoW — V2 获得新 revision，V1 不变", async () => {
    expect(await cueRevRefCount(origRev)).toBe(2);
    await updateCue(origRev, CL, { name: "V2 名" }, v2Id);
    const r1 = await cueRevisionId(v1Id, "g4-cue1");
    const r2 = await cueRevisionId(v2Id, "g4-cue1");
    expect(r1).toBe(origRev);
    expect(r2).not.toBe(origRev);
    expect(await cueName(origRev)).toBe("原始名");
    expect(await cueName(r2!)).toBe("V2 名");
  });

  it("refCount = 1：updateCue 原地更新（revision_id 不变）", async () => {
    const v2Rev = (await cueRevisionId(v2Id, "g4-cue1"))!;
    expect(await cueRevRefCount(v2Rev)).toBe(1);
    await updateCue(v2Rev, CL, { name: "V2 再改" }, v2Id);
    const v2RevAfter = await cueRevisionId(v2Id, "g4-cue1");
    expect(v2RevAfter).toBe(v2Rev);                          // same physical row
    expect(await cueName(v2RevAfter!)).toBe("V2 再改");
  });
});

// ─── G4b: Cue CoW — 只 remap 本版本（级联已随分支概念退役）───────────────────

describe("cue CoW — 版本本地 remap，不波及其他共享版本", () => {
  const PROD = "test-vcs-cue-casc";
  const CL   = "vcs-cl-cue-casc";
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "Cue 本地 remap 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await mkCueList(PROD, CL);
    await mkCue("casc-cue1", CL, "初始", v1Id);
    // v1/v2/v3 共享同一 revision（refCount = 3），从 v2 触发 CoW
    v2Id = await makeLegacyVersion(PROD, v1Id);
    v3Id = await makeLegacyVersion(PROD, v2Id);
    const rev = (await cueRevisionId(v2Id, "casc-cue1"))!;
    await updateCue(rev, CL, { name: "V2 改" }, v2Id);
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("V2 得到新 revision，内容正确", async () => {
    expect(await cueName((await cueRevisionId(v2Id, "casc-cue1"))!)).toBe("V2 改");
  });

  it("V1 不受影响", async () => {
    expect(await cueName((await cueRevisionId(v1Id, "casc-cue1"))!)).toBe("初始");
  });

  it("V3 不受影响（级联已退役——CoW 只 remap 触发版本自己）", async () => {
    const r2 = await cueRevisionId(v2Id, "casc-cue1");
    const r3 = await cueRevisionId(v3Id, "casc-cue1");
    expect(r3).not.toBe(r2);
    expect(await cueName(r3!)).toBe("初始");
  });
});

// ─── G5: Cue GC ───────────────────────────────────────────────────────────────

describe("cue GC — deleteCue 引用计数守护", () => {
  const PROD = "test-vcs-cue-gc";
  const CL   = "vcs-cl-cue-gc";
  let v1Id: string;
  let v2Id: string;
  let origRevId: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "Cue GC 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await mkCueList(PROD, CL);
    await mkCue("gc-cue1", CL, "GC 测试 cue", v1Id);
    v2Id = await makeLegacyVersion(PROD, v1Id);
    origRevId = (await cueRevisionId(v1Id, "gc-cue1"))!;
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("从 V2 删除共享 cue：physical 行仍存在，V1 的 cue_version 条目保留", async () => {
    await deleteCue(origRevId, CL, v2Id);
    expect(await physicalCueExists(origRevId)).toBe(true);
    expect(await cueRevisionId(v2Id, "gc-cue1")).toBeNull();      // V2 entry gone
    expect(await cueRevisionId(v1Id, "gc-cue1")).toBe(origRevId); // V1 still intact
  });

  it("从 V1 再删除 cue：physical 行被 GC", async () => {
    await deleteCue(origRevId, CL, v1Id);
    expect(await physicalCueExists(origRevId)).toBe(false);
  });
});

// ─── G6: cowBlockSnapshotForMount ─────────────────────────────────────────────

describe("cowBlockSnapshotForMount — 本版本分裂", () => {
  const PROD = "test-vcs-cow-mount";
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;
  let snapNoop: string;    // exclusively in v3 (refCount=1)
  let snapVo: string;      // shared by v1/v2/v3

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "cowBlockSnapshotForMount 测试", TEST_OWNER);
    v1Id = (await getActiveVersionId(PROD))!;
    await applyPatchToDB(PROD, v1Id, ins(mkBlock("cm-vo", "共享测试块")));
    snapVo = (await snapshotId(v1Id, "cm-vo"))!;
    v2Id = await makeLegacyVersion(PROD, v1Id);
    v3Id = await makeLegacyVersion(PROD, v2Id);
    // An exclusive block only in v3 (refCount=1) for the noop test
    await applyPatchToDB(PROD, v3Id, ins(mkBlock("cm-noop", "仅 V3 的块")));
    snapNoop = (await snapshotId(v3Id, "cm-noop"))!;
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("refCount=1：返回原 snapshotId，不创建新行", async () => {
    expect(await snapshotRefCount(snapNoop)).toBe(1);
    const result = await cowBlockSnapshotForMount(v3Id, snapNoop);
    expect(result).toBe(snapNoop);
    expect(await snapshotRefCount(snapNoop)).toBe(1);    // unchanged
  });

  it("refCount>1：只有本 version 的 script_version 行被 remap", async () => {
    expect(await snapshotRefCount(snapVo)).toBe(3);      // v1/v2/v3
    const newSnap = await cowBlockSnapshotForMount(v2Id, snapVo);
    expect(newSnap).not.toBe(snapVo);
    expect(await snapshotId(v1Id, "cm-vo")).toBe(snapVo);   // v1 unchanged
    expect(await snapshotId(v2Id, "cm-vo")).toBe(newSnap);  // v2 remapped
    expect(await snapshotId(v3Id, "cm-vo")).toBe(snapVo);   // v3 unchanged
  });
});

// ─── G7: 并发安全 — advisory lock 串行化 ─────────────────────────────────────

describe("并发安全 — pg_advisory_xact_lock 串行化", () => {
  const PROD = "test-vcs-concur";
  const CL   = "vcs-cl-concur";
  let vId: string;

  beforeAll(async () => {
    await deleteProduction(PROD).catch(() => {});
    await createProduction(PROD, "并发安全测试", TEST_OWNER);
    vId = (await getActiveVersionId(PROD))!;
    await applyPatchToDB(PROD, vId, ins(mkBlock("cc1", "并发块1")));
    await applyPatchToDB(PROD, vId, ins(mkBlock("cc2", "并发块2"), "cc1"));
    await mkCueList(PROD, CL);
    await mkCue("cc-cue1", CL, "并发 Q1 原始", vId);
    await mkCue("cc-cue2", CL, "并发 Q2 原始", vId);
  });

  afterAll(async () => { await deleteProduction(PROD).catch(() => {}); });

  it("两个并发 applyPatchToDB 都完成，block 内容均正确", async () => {
    await Promise.all([
      applyPatchToDB(PROD, vId, upd(mkBlock("cc1", "并发改A"))),
      applyPatchToDB(PROD, vId, upd(mkBlock("cc2", "并发改B"))),
    ]);
    const s1 = await snapshotId(vId, "cc1");
    const s2 = await snapshotId(vId, "cc2");
    expect(await snapshotContent(s1!)).toBe("并发改A");
    expect(await snapshotContent(s2!)).toBe("并发改B");
  });

  it("两个并发 updateCue 在同一 version 不产生数据冲突", async () => {
    const rev1 = (await cueRevisionId(vId, "cc-cue1"))!;
    const rev2 = (await cueRevisionId(vId, "cc-cue2"))!;
    await Promise.all([
      updateCue(rev1, CL, { name: "并发 Q1 改" }, vId),
      updateCue(rev2, CL, { name: "并发 Q2 改" }, vId),
    ]);
    const rA = await cueRevisionId(vId, "cc-cue1");
    const rB = await cueRevisionId(vId, "cc-cue2");
    expect(await cueName(rA!)).toBe("并发 Q1 改");
    expect(await cueName(rB!)).toBe("并发 Q2 改");
  });
});
