/**
 * Import pipeline tests:
 *   A. importScriptToVersion — DB integration (full replacement, character links, cross-production isolation)
 *   B. flushToDBVersioned scene-only path — add / delete / upsert
 *   C. parseSceneNum — pure function (various formats)
 *   D. buildSceneRows / buildSceneMap — pure function (tabular data → structured entries)
 *   E. version-import hybrid — CoW block/cue isolation, orphan GC, v1 preservation
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createProduction,
  importScriptToVersion, flushToDBVersioned,
  getActiveVersionId, createVersion,
  createCueList, createCue, updateCue,
  applyPatchToDB,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { initialKeys } from "@/lib/lex-order";
import { parseSceneNum } from "@/lib/import/parse-scene-num";
import { buildSceneRows, buildSceneMap } from "@/lib/import/scene-builder";

// ── shared DB helpers ─────────────────────────────────────────────────────────

async function countScriptVersion(versionId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM script_version WHERE version_id = $1",
    [versionId],
  );
  return parseInt(r.rows[0].count);
}

async function countCharacterVersion(versionId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM character_version WHERE version_id = $1",
    [versionId],
  );
  return parseInt(r.rows[0].count);
}

async function countSceneVersion(versionId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM scene_version WHERE version_id = $1",
    [versionId],
  );
  return parseInt(r.rows[0].count);
}

async function scriptCharLinks(snapshotId: string): Promise<string[]> {
  const r = await getPool().query<{ character_id: string }>(
    "SELECT character_id FROM script_character WHERE script_id = $1 ORDER BY position",
    [snapshotId],
  );
  return r.rows.map(row => row.character_id);
}

async function snapshotContent(snapshotId: string): Promise<string | null> {
  const r = await getPool().query<{ content: string }>(
    "SELECT content FROM script WHERE id = $1",
    [snapshotId],
  );
  return r.rows[0]?.content ?? null;
}

async function snapshotIdForBlock(versionId: string, blockId: string): Promise<string | null> {
  const r = await getPool().query<{ snapshot_id: string }>(
    "SELECT snapshot_id FROM script_version WHERE version_id = $1 AND block_id = $2",
    [versionId, blockId],
  );
  return r.rows[0]?.snapshot_id ?? null;
}

async function sceneNumsForVersion(versionId: string): Promise<string[]> {
  const r = await getPool().query<{ num: string }>(
    "SELECT num FROM scene_version WHERE version_id = $1 ORDER BY sort_order",
    [versionId],
  );
  return r.rows.map(row => row.num);
}

async function sceneIdentityExists(sceneId: string): Promise<boolean> {
  const r = await getPool().query<{ id: string }>(
    "SELECT id FROM scene WHERE id = $1",
    [sceneId],
  );
  return r.rows.length > 0;
}

// character_version.character_id and scene_version.scene_id both lack ON DELETE CASCADE,
// so we must delete them manually before deleteProduction can cascade.
async function forceDeleteProduction(prodId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM character_version WHERE character_id IN (SELECT id FROM character WHERE production_id = $1)",
    [prodId],
  );
  await getPool().query(
    "DELETE FROM scene_version WHERE scene_id IN (SELECT id FROM scene WHERE production_id = $1)",
    [prodId],
  );
  await getPool().query("DELETE FROM production WHERE id = $1", [prodId]);
}

async function physicalSnapshotExists(snapshotId: string): Promise<boolean> {
  const r = await getPool().query<{ id: string }>(
    "SELECT id FROM script WHERE id = $1",
    [snapshotId],
  );
  return r.rows.length > 0;
}

async function countCueVersion(versionId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM cue_version WHERE version_id = $1",
    [versionId],
  );
  return parseInt(r.rows[0].count);
}

async function physicalCueExists(revisionId: string): Promise<boolean> {
  const r = await getPool().query<{ id: string }>(
    "SELECT id FROM cue WHERE id = $1",
    [revisionId],
  );
  return r.rows.length > 0;
}

async function cueRevisionIdForVersion(versionId: string, logicalCueId: string): Promise<string | null> {
  const r = await getPool().query<{ revision_id: string }>(
    "SELECT revision_id FROM cue_version WHERE version_id = $1 AND cue_id = $2",
    [versionId, logicalCueId],
  );
  return r.rows[0]?.revision_id ?? null;
}

// ── Group A: importScriptToVersion ────────────────────────────────────────────

const PROD_A      = "test-import-a";
const PROD_A_ISO  = "test-import-a-iso";

describe("A: importScriptToVersion DB integration", () => {
  let versionId: string;

  beforeAll(async () => {
    await forceDeleteProduction(PROD_A).catch(() => {});
    await forceDeleteProduction(PROD_A_ISO).catch(() => {});
    await createProduction(PROD_A, "导入测试-剧本");
    versionId = (await getActiveVersionId(PROD_A))!;
    await createProduction(PROD_A_ISO, "隔离用演出");
  });

  afterAll(async () => {
    await forceDeleteProduction(PROD_A).catch(() => {});
    await forceDeleteProduction(PROD_A_ISO).catch(() => {});
  });

  const [key1, key2, key3] = initialKeys(3);

  const scene1 = { id: "imp-sc1", number: "1", name: "幕一", parentId: null, sortOrder: 1 };
  const scene2 = { id: "imp-sc2", number: "1-1", name: "第一场", parentId: "imp-sc1", sortOrder: 2 };
  const char1  = { id: "imp-ch1", name: "主角", isAggregate: false, sortOrder: 1 };
  const char2  = { id: "imp-ch2", name: "配角", isAggregate: false, sortOrder: 2 };

  const block1 = {
    id: "imp-b1", blockId: "imp-b1",
    type: "dialogue" as const, content: "台词甲", lyric: false,
    characterIds: ["imp-ch1"], characterAnnotations: {},
    sceneId: "imp-sc2", rehearsalMark: null, lexKey: key1,
  };
  const block2 = {
    id: "imp-b2", blockId: "imp-b2",
    type: "stage" as const, content: "舞台提示", lyric: false,
    characterIds: [], characterAnnotations: {},
    sceneId: "imp-sc2", rehearsalMark: null, lexKey: key2,
  };
  const block3 = {
    id: "imp-b3", blockId: "imp-b3",
    type: "dialogue" as const, content: "台词乙", lyric: false,
    characterIds: ["imp-ch1", "imp-ch2"], characterAnnotations: { "imp-ch2": "旁白" },
    sceneId: "imp-sc2", rehearsalMark: null, lexKey: key3,
  };

  it("A1: inserts 3 blocks and 2 characters; scene identity rows created in global table", async () => {
    await importScriptToVersion(PROD_A, versionId, {
      upsertBlocks: [block1, block2, block3],
      upsertChars: [char1, char2],
      upsertScenes: [scene1, scene2],
    });

    expect(await countScriptVersion(versionId)).toBe(3);
    expect(await countCharacterVersion(versionId)).toBe(2);
    // scene identity rows must exist in the global table (FK anchors)
    expect(await sceneIdentityExists("imp-sc1")).toBe(true);
    expect(await sceneIdentityExists("imp-sc2")).toBe(true);
  });

  it("A2: block content is stored correctly", async () => {
    const sid = await snapshotIdForBlock(versionId, "imp-b1");
    expect(sid).not.toBeNull();
    expect(await snapshotContent(sid!)).toBe("台词甲");
  });

  it("A3: character associations are stored with correct positions", async () => {
    const sid1 = await snapshotIdForBlock(versionId, "imp-b1");
    const sid3 = await snapshotIdForBlock(versionId, "imp-b3");
    expect(await scriptCharLinks(sid1!)).toEqual(["imp-ch1"]);
    expect(await scriptCharLinks(sid3!)).toEqual(["imp-ch1", "imp-ch2"]);
  });

  it("A4: full replacement clears old blocks and GCs orphan snapshots", async () => {
    const [newKey] = initialKeys(1);
    const newBlock = {
      id: "imp-b4", blockId: "imp-b4",
      type: "dialogue" as const, content: "全新台词", lyric: false,
      characterIds: [], characterAnnotations: {},
      sceneId: null, rehearsalMark: null, lexKey: newKey,
    };

    await importScriptToVersion(PROD_A, versionId, {
      upsertBlocks: [newBlock],
      upsertChars: [],
      upsertScenes: [],
    });

    expect(await countScriptVersion(versionId)).toBe(1);
    const sid = await snapshotIdForBlock(versionId, "imp-b4");
    expect(await snapshotContent(sid!)).toBe("全新台词");

    // orphan snapshots sole-referenced by this version must be GC'd
    const orphans = await getPool().query<{ id: string }>(
      "SELECT id FROM script WHERE id = ANY($1::text[])",
      [["imp-b1", "imp-b2", "imp-b3"]],
    );
    expect(orphans.rows).toHaveLength(0);
  });

  it("A5: cross-production isolation — PROD_A_ISO version has no blocks", async () => {
    const isoVersionId = (await getActiveVersionId(PROD_A_ISO))!;
    expect(await countScriptVersion(isoVersionId)).toBe(0);
  });
});

// ── Group B: flushToDBVersioned scene-only path ───────────────────────────────

const PROD_B = "test-import-b";

describe("B: flushToDBVersioned scene-only path", () => {
  let versionId: string;

  beforeAll(async () => {
    await forceDeleteProduction(PROD_B).catch(() => {});
    await createProduction(PROD_B, "导入测试-场景");
    versionId = (await getActiveVersionId(PROD_B))!;
  });

  afterAll(async () => {
    await forceDeleteProduction(PROD_B).catch(() => {});
  });

  it("B1: adds scenes to empty version", async () => {
    await flushToDBVersioned(PROD_B, versionId, {
      upsertScenes: [
        { id: "b-sc1", number: "1", name: "第一幕", parentId: null, sortOrder: 1 },
        { id: "b-sc2", number: "1-1", name: "第一场", parentId: "b-sc1", sortOrder: 2 },
      ],
      deleteSceneIds: [],
      upsertBlocks: [], deleteSnapshotIds: [],
      upsertChars: [], deleteCharIds: [],
    });

    const nums = await sceneNumsForVersion(versionId);
    expect(nums).toContain("1");
    expect(nums).toContain("1-1");
  });

  it("B2: upsert updates existing scene name", async () => {
    await flushToDBVersioned(PROD_B, versionId, {
      upsertScenes: [{ id: "b-sc1", number: "1", name: "序幕（改名）", parentId: null, sortOrder: 1 }],
      deleteSceneIds: [],
      upsertBlocks: [], deleteSnapshotIds: [],
      upsertChars: [], deleteCharIds: [],
    });

    const r = await getPool().query<{ name: string }>(
      "SELECT name FROM scene_version WHERE scene_id = $1 AND version_id = $2",
      ["b-sc1", versionId],
    );
    expect(r.rows[0]?.name).toBe("序幕（改名）");
  });

  it("B3: deleteSceneIds removes scene from scene_version but global scene row persists", async () => {
    await flushToDBVersioned(PROD_B, versionId, {
      upsertScenes: [],
      deleteSceneIds: ["b-sc2"],
      upsertBlocks: [], deleteSnapshotIds: [],
      upsertChars: [], deleteCharIds: [],
    });

    const nums = await sceneNumsForVersion(versionId);
    expect(nums).not.toContain("1-1");

    // global identity row must survive — other versions/productions may reference it
    expect(await sceneIdentityExists("b-sc2")).toBe(true);
  });

  it("B4: replaceExisting=false leaves unlisted scenes intact", async () => {
    // scene "1" is still present from B1; add a new one without deleting existing
    await flushToDBVersioned(PROD_B, versionId, {
      upsertScenes: [{ id: "b-sc3", number: "2", name: "第二幕", parentId: null, sortOrder: 2 }],
      deleteSceneIds: [],
      upsertBlocks: [], deleteSnapshotIds: [],
      upsertChars: [], deleteCharIds: [],
    });

    const nums = await sceneNumsForVersion(versionId);
    expect(nums).toContain("1");
    expect(nums).toContain("2");
  });
});

// ── Group C: parseSceneNum pure function ─────────────────────────────────────

describe("C: parseSceneNum", () => {
  it("C1: pure number → top-level act, no child", () => {
    const r = parseSceneNum("1");
    expect(r?.parentNum).toBe("1");
    expect(r?.childNum).toBeNull();
    expect(r?.parentName).toBeNull();
  });

  it("C2: number+CJK name → top-level act with name", () => {
    const r = parseSceneNum("1选择");
    expect(r?.parentNum).toBe("1");
    expect(r?.parentName).toBe("选择");
    expect(r?.childNum).toBeNull();
  });

  it("C3: 'N-N' → parent and child with no names", () => {
    const r = parseSceneNum("1-1");
    expect(r?.parentNum).toBe("1");
    expect(r?.childNum).toBe("1-1");
    expect(r?.parentName).toBeNull();
    expect(r?.childName).toBeNull();
  });

  it("C4: 'Nname-N' → parent with name, child without name", () => {
    const r = parseSceneNum("1选择-1");
    expect(r?.parentNum).toBe("1");
    expect(r?.parentName).toBe("选择");
    expect(r?.childNum).toBe("1-1");
    expect(r?.childName).toBeNull();
  });

  it("C5: 'N-N trailing name' → child with name", () => {
    const r = parseSceneNum("1-1 供养");
    expect(r?.parentNum).toBe("1");
    expect(r?.childNum).toBe("1-1");
    expect(r?.childName).toBe("供养");
  });

  it("C6: empty / whitespace-only → null", () => {
    expect(parseSceneNum("")).toBeNull();
    expect(parseSceneNum("   ")).toBeNull();
  });

  it("C7: leading-zero number is top-level act", () => {
    const r = parseSceneNum("01");
    expect(r?.parentNum).toBe("01");
    expect(r?.childNum).toBeNull();
  });

  it("C8: raw field is preserved", () => {
    const raw = "2选择-3 大结局";
    const r = parseSceneNum(raw);
    expect(r?.raw).toBe(raw);
    expect(r?.parentNum).toBe("2");
    expect(r?.childNum).toBe("2-3");
    expect(r?.childName).toBe("大结局");
  });
});

// ── Group D: buildSceneRows ───────────────────────────────────────────────────

describe("D: buildSceneRows", () => {
  it("D1: basic rows → SceneRow array with correct fields", () => {
    const rows: (string | null)[][] = [
      ["1", "第一幕"],
      ["1-1", "第一场"],
    ];
    const result = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    expect(result).toHaveLength(2);
    expect(result[0].rawNum).toBe("1");
    expect(result[0].name).toBe("第一幕");
    expect(result[1].parsed.childNum).toBe("1-1");
  });

  it("D2: empty sceneNum cell is skipped", () => {
    const rows: (string | null)[][] = [
      [null, "无编号"],
      ["2", "第二幕"],
    ];
    expect(buildSceneRows(rows, { sceneNum: 0, sceneName: 1 })).toHaveLength(1);
  });

  it("D3: headerRowIncluded strips first non-empty row", () => {
    const rows: (string | null)[][] = [
      ["场次编号", "场次名称"],
      ["1", "序幕"],
    ];
    const result = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 }, true);
    expect(result).toHaveLength(1);
    expect(result[0].rawNum).toBe("1");
  });

  it("D4: name falls back to parsed name when sceneName col is absent", () => {
    const rows: (string | null)[][] = [["1选择", null]];
    const result = buildSceneRows(rows, { sceneNum: 0 });
    expect(result[0].name).toBe("选择");
  });

  it("D5: optional metadata columns are mapped", () => {
    const rows: (string | null)[][] = [
      ["1", "幕一", "简介文字", "调度", "音乐", "舞台呈现", "45分钟"],
    ];
    const colMap = { sceneNum: 0, sceneName: 1, intro: 2, actionLine: 3, music: 4, stagePres: 5, duration: 6 };
    const [r] = buildSceneRows(rows, colMap);
    expect(r.intro).toBe("简介文字");
    expect(r.actionLine).toBe("调度");
    expect(r.music).toBe("音乐");
    expect(r.stagePres).toBe("舞台呈现");
    expect(r.duration).toBe("45分钟");
  });

  it("D6: impliedParentName is set only for child rows", () => {
    const rows: (string | null)[][] = [
      ["1选择-1", null],
      ["2",       null],
    ];
    const result = buildSceneRows(rows, { sceneNum: 0 });
    expect(result[0].impliedParentName).toBe("选择");
    expect(result[1].impliedParentName).toBeNull();
  });
});

// ── Group D continued: buildSceneMap ─────────────────────────────────────────

describe("D: buildSceneMap", () => {
  it("D7: top-level acts only — no parentNum", () => {
    const rows: (string | null)[][] = [["1", "第一幕"], ["2", "第二幕"]];
    const sceneRows = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    const map = buildSceneMap(sceneRows, new Map(), 1);
    expect(map.size).toBe(2);
    expect(map.get("1")?.parentNum).toBeNull();
    expect(map.get("2")?.parentNum).toBeNull();
  });

  it("D8: child row implies parent creation with parentName as name", () => {
    const rows: (string | null)[][] = [["1选择-1", "第一场"]];
    const sceneRows = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    const map = buildSceneMap(sceneRows, new Map(), 1);
    expect(map.has("1")).toBe(true);
    expect(map.get("1-1")?.parentNum).toBe("1");
    expect(map.get("1")?.name).toBe("选择");
  });

  it("D9: duplicate scene num → deduplicated to one entry", () => {
    const rows: (string | null)[][] = [["1", "幕一"], ["1", "幕一（重复）"]];
    const sceneRows = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    const map = buildSceneMap(sceneRows, new Map(), 1);
    expect(map.size).toBe(1);
  });

  it("D10: existingByNum reuses existing id and marks sortOrder -1", () => {
    const existing = new Map([["1", { id: "existing-id-1", number: "1", name: "幕一" }]]);
    const rows: (string | null)[][] = [["1", "幕一"]];
    const sceneRows = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    const map = buildSceneMap(sceneRows, existing, 1);
    expect(map.get("1")?.id).toBe("existing-id-1");
    expect(map.get("1")?.sortOrder).toBe(-1);
  });

  it("D11: new scenes get incremental sortOrders from initialSortOrder", () => {
    const rows: (string | null)[][] = [["1", "幕一"], ["2", "幕二"]];
    const sceneRows = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    const map = buildSceneMap(sceneRows, new Map(), 10);
    expect(map.get("1")?.sortOrder).toBe(10);
    expect(map.get("2")?.sortOrder).toBe(11);
  });

  it("D12: name upgrade — nameless entry gets name when later row provides it", () => {
    // First row "1-1" creates implied parent "1" with no explicit name
    // Second row "1 幕名" provides the name for "1"
    const rows: (string | null)[][] = [
      ["1-1", null],
      ["1",   "幕名"],
    ];
    const sceneRows = buildSceneRows(rows, { sceneNum: 0, sceneName: 1 });
    const map = buildSceneMap(sceneRows, new Map(), 1);
    expect(map.get("1")?.name).toBe("幕名");
  });
});

// ── Group E: version-import hybrid ───────────────────────────────────────────
//
// Scenario:
//   v1: B1, B2, B3 (imported) + cue CQ_rev1
//   v2 (fork of v1): inherits B1, B2, B3 + CQ_rev1
//     → CoW B2 in v2: new snapshot snap-b2-v2 (sole in v2); snap-b2-orig now sole in v1
//     → CoW CQ in v2: new revision CQ_rev2 (sole in v2); CQ_rev1 now sole in v1
//   Import [B4] to v2 (full replacement)
//
// Key assertions:
//   - snap-b2-v2 GC'd (v2 sole → deleted)
//   - snap-b1, snap-b3 survive (shared → v1 still holds them)
//   - snap-b2-orig survives (v1 sole → untouched)
//   - v2.cue_version cleared; CQ_rev2 GC'd (v2 sole cue)
//   - v1.cue_version + CQ_rev1 intact

const PROD_E    = "test-import-e";
const CL_E_ID   = "test-imp-cl-e";
const CUE_E_ID  = "test-imp-cue-e";

describe("E: version-import hybrid — CoW block/cue isolation and GC", () => {
  let v1Id: string;
  let v2Id: string;
  let snapB2InV2:  string;
  let cueRev2Id:   string;

  beforeAll(async () => {
    await forceDeleteProduction(PROD_E).catch(() => {});
    // clean up cue_list if leftover (cue_list has FK to production which cascades, but
    // forceDeleteProduction handles that — just ensure no stale rows before recreating)
    await getPool().query("DELETE FROM cue_list WHERE id = $1", [CL_E_ID]).catch(() => {});

    await createProduction(PROD_E, "混合测试演出");
    v1Id = (await getActiveVersionId(PROD_E))!;

    // ── Step 1: import B1, B2, B3 into v1 ─────────────────────────────────────
    const [k1, k2, k3] = initialKeys(3);
    await importScriptToVersion(PROD_E, v1Id, {
      upsertBlocks: [
        { id: "e-snap-b1", blockId: "e-b1", type: "dialogue", content: "B1内容", lyric: false, characterIds: [], characterAnnotations: {}, sceneId: null, rehearsalMark: null, lexKey: k1 },
        { id: "e-snap-b2", blockId: "e-b2", type: "dialogue", content: "B2内容", lyric: false, characterIds: [], characterAnnotations: {}, sceneId: null, rehearsalMark: null, lexKey: k2 },
        { id: "e-snap-b3", blockId: "e-b3", type: "dialogue", content: "B3内容", lyric: false, characterIds: [], characterAnnotations: {}, sceneId: null, rehearsalMark: null, lexKey: k3 },
      ],
      upsertChars: [],
      upsertScenes: [],
    });

    // ── Step 2: create cue list + cue (revision CUE_E_ID) bound to v1 ─────────
    const gap = { kind: "gap" as const, afterBlockId: null };
    await createCueList({ id: CL_E_ID, productionId: PROD_E, name: "混合测试走位表", notes: "", abbr: null, template: null, defaultEditRoles: [], createdBy: "test-sys-user" });
    await createCue({ id: CUE_E_ID, cueListId: CL_E_ID, number: "Q1", name: "混合测试Q", content: "", start: gap, end: gap, versionId: v1Id });

    // ── Step 3: fork v2 from v1 (inherits script_version + cue_version) ────────
    const v2 = await createVersion(PROD_E, v1Id, "v2分支");
    v2Id = v2.id;

    // ── Step 4: CoW B2 in v2 — new snapshot sole-owned by v2 ──────────────────
    await applyPatchToDB(PROD_E, v2Id, {
      clientSeq: 1,
      blockOps: [{ op: "update", block: { id: "e-b2", type: "dialogue", content: "B2-v2修改", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null } }],
      charOps: [],
      sceneOps: [],
    });
    snapB2InV2 = (await snapshotIdForBlock(v2Id, "e-b2"))!;

    // ── Step 5: CoW cue in v2 — new revision sole-owned by v2 ─────────────────
    // refCount of CUE_E_ID is now 2 (v1 + v2), so updateCue triggers CoW
    await updateCue(CUE_E_ID, CL_E_ID, { name: "Q1-v2改名" }, v2Id);
    cueRev2Id = (await cueRevisionIdForVersion(v2Id, CUE_E_ID))!;

    // ── Step 6: import [B4] to v2 — full replacement ───────────────────────────
    const [k4] = initialKeys(1);
    await importScriptToVersion(PROD_E, v2Id, {
      upsertBlocks: [
        { id: "e-snap-b4", blockId: "e-b4", type: "dialogue", content: "B4新内容", lyric: false, characterIds: [], characterAnnotations: {}, sceneId: null, rehearsalMark: null, lexKey: k4 },
      ],
      upsertChars: [],
      upsertScenes: [],
    });
  });

  afterAll(async () => {
    await forceDeleteProduction(PROD_E).catch(() => {});
  });

  it("E1: v2 has only the newly imported block", async () => {
    expect(await countScriptVersion(v2Id)).toBe(1);
    expect(await snapshotIdForBlock(v2Id, "e-b4")).not.toBeNull();
  });

  it("E2: v1 blocks are completely untouched after v2 import", async () => {
    expect(await countScriptVersion(v1Id)).toBe(3);
    expect(await snapshotContent(await snapshotIdForBlock(v1Id, "e-b1") as string)).toBe("B1内容");
    expect(await snapshotContent(await snapshotIdForBlock(v1Id, "e-b2") as string)).toBe("B2内容");
    expect(await snapshotContent(await snapshotIdForBlock(v1Id, "e-b3") as string)).toBe("B3内容");
  });

  it("E3: v2-sole snapshot (B2 after CoW) is GC'd", async () => {
    expect(await physicalSnapshotExists(snapB2InV2)).toBe(false);
  });

  it("E4: shared snapshots (B1, B3) survive — v1 still references them", async () => {
    const snapB1V1 = (await snapshotIdForBlock(v1Id, "e-b1"))!;
    const snapB3V1 = (await snapshotIdForBlock(v1Id, "e-b3"))!;
    expect(await physicalSnapshotExists(snapB1V1)).toBe(true);
    expect(await physicalSnapshotExists(snapB3V1)).toBe(true);
  });

  it("E5: v1-sole snapshot (original B2 before v2 CoW) survives", async () => {
    // v2 had already diverged from this snapshot before the import, so it was never
    // an orphan from import's perspective — v1 is the sole remaining reference.
    const snapB2V1 = (await snapshotIdForBlock(v1Id, "e-b2"))!;
    expect(await physicalSnapshotExists(snapB2V1)).toBe(true);
  });

  it("E6: v2 cue_version is empty after import", async () => {
    expect(await countCueVersion(v2Id)).toBe(0);
  });

  it("E7: v1 cue_version is untouched — still holds the original revision", async () => {
    expect(await cueRevisionIdForVersion(v1Id, CUE_E_ID)).toBe(CUE_E_ID);
  });

  it("E8: v2-sole cue revision (after CoW) is GC'd", async () => {
    expect(cueRev2Id).not.toBe(CUE_E_ID); // sanity: CoW did create a new row
    expect(await physicalCueExists(cueRev2Id)).toBe(false);
  });

  it("E9: v1's original cue revision still exists in cue table", async () => {
    expect(await physicalCueExists(CUE_E_ID)).toBe(true);
  });
});
