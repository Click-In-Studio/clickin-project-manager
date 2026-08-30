/**
 * 页码统一读口（#336 阶段 B1）。
 *
 * 钉的是 issue 的正题：`computePageMap` 有四个消费点，三处硬编码 a4/center、cue 页
 * 漏传 textLayoutMode——用 letter / compact 的剧组，搜索与 @提及 报的是别的版式的页码。
 * 现在四处全走 `getEstimatedPageMap`，它读 `production.page_map` 里按演出实际版式
 * 预算好的那份，缺失时现算兜底。
 *
 * 证人是一个 **letter + compact** 的演出：内容要多到 a4/center 与 letter/compact 的
 * 分页真的不同，否则「传了真实版式」与「硬编码 a4」在断言上分不出来。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  applyPatchToDB,
  getEstimatedPageMap,
  getMasterScriptViewId,
  loadPageMap,
  loadProduction,
  savePageMap,
  saveScriptConfig,
} from "@/lib/db";
import { computePageMap } from "@/lib/script-page";
import { DEFAULT_SCRIPT_CONFIG, type Block } from "@/lib/script-types";
import { buildMarkerLabelIndex } from "@/lib/script-generated-labels";
import { GET as pagesGET } from "@/app/api/script/[id]/pages/route";
import { GET as blockSearchGET } from "@/app/api/production/[id]/script/block-search/route";
import { POST as mentionResolvePOST } from "@/app/api/production/[id]/mention-resolve/route";
import { makeProduction, cleanupProduction, makeScene } from "./factories";

let prodId: string;
let versionId: string;
let owner: string;
let sceneId: string;
let sceneNum: string;
/** 本测试插入的正文块 id（按序）；第 10 块之后插了一个排练记号 */
const blockIds: string[] = [];
const REHEARSAL_AFTER = 10;
let rehearsalMarkerId: string;
/**
 * 版本里**全部**正文块 id（按 sort_key 序，含工厂/补丁自动插入的块——makeScene 会在
 * 章节标记后自动生成首个排练记号，applyPatchToDB 会在尾部补一个空块）。等价性断言
 * 一律从这份原始顺序推期望，不经 marker 归属投影——那正是被测代码在用的东西。
 */
let allBlocks: Block[] = [];
const textIds = () => allBlocks.filter(b => !["chapter_marker", "scene_marker", "rehearsal_marker"].includes(b.type)).map(b => b.id);
/** 某个 marker 之后、下一个 marker 之前的正文块 id（原始顺序） */
function textIdsUnderMarker(markerId: string): string[] {
  const start = allBlocks.findIndex(b => b.id === markerId);
  const ids: string[] = [];
  for (const b of allBlocks.slice(start + 1)) {
    if (["chapter_marker", "scene_marker", "rehearsal_marker"].includes(b.type)) break;
    ids.push(b.id);
  }
  return ids;
}

/** letter/compact 的真页码（期望值）与 a4/center 的页码（旧 bug 会报的值） */
let expected: Record<string, number>;
let wrongA4: Record<string, number>;

const cookie = () =>
  `${SESSION_COOKIE}=${createSession({ userId: owner, name: "测试", avatarUrl: null, isAdmin: false })}`;
const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

function searchReq(q: string) {
  return new NextRequest(
    `http://localhost/api/production/${prodId}/script/block-search?q=${encodeURIComponent(q)}`,
    { headers: { cookie: cookie() } },
  );
}

async function search(q: string): Promise<{ status: number; results: Array<{ id: string; displayLabel: string; kind: string }> }> {
  const res = await blockSearchGET(searchReq(q), ctx());
  const data = res.status === 200 ? await res.json() as { results: Array<{ id: string; displayLabel: string; kind: string }> } : { results: [] };
  return { status: res.status, results: data.results };
}

async function resolve(mentions: Array<{ kind: string; id: string; displayMode?: string | null }>): Promise<{ labels: (string | null)[]; urls: (string | null)[] }> {
  const req = new NextRequest(`http://localhost/api/production/${prodId}/mention-resolve`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify({
      mentions: mentions.map(m => ({ displayMode: null, aux: null, versionId: null, ...m })),
      versionId,
    }),
  });
  const res = await mentionResolvePOST(req, ctx());
  expect(res.status).toBe(200);
  return await res.json() as { labels: (string | null)[]; urls: (string | null)[] };
}

function insert(block: Block, afterId: string | null) {
  return applyPatchToDB(prodId, versionId, {
    clientSeq: 1,
    blockOps: [{ op: "insert", block, afterId }],
    charOps: [],
    sceneOps: [],
  });
}

beforeAll(async () => {
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  owner = u.rows[0].id;
  ({ prodId, versionId } = await makeProduction(owner));
  sceneId = await makeScene(prodId, versionId, { number: "1", name: "证人场" });

  // 30 块 × 140 个全角字：a4/center 每行 46 单位、letter/compact 每行 36 单位，
  // 行数不同 → 分页不同。内容用确定性文本，不靠 faker。
  let afterId: string | null = sceneId;
  for (let i = 0; i < 30; i++) {
    const id = randomUUID();
    blockIds.push(id);
    const content = `第${i + 1}块：` + "这一句台词是为了把页撑满而写的证人文本，".repeat(7);
    await insert({
      id, type: "dialogue", content, characterIds: [], characterAnnotations: {},
      lyric: false, sceneId: null, rehearsalMark: null,
    }, afterId);
    afterId = id;
    if (i + 1 === REHEARSAL_AFTER) {
      rehearsalMarkerId = randomUUID();
      await insert({
        id: rehearsalMarkerId, type: "rehearsal_marker", content: "", characterIds: [], characterAnnotations: {},
        lyric: false, sceneId: null, rehearsalMark: null, markerMeta: {},
      }, afterId);
      afterId = rehearsalMarkerId;
    }
  }

  // 证人版式：letter + compact。saveScriptConfig 会触发 page_map 全量重算。
  await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG, pageLayout: "letter", textLayoutMode: "compact" });

  const loaded = (await loadProduction(prodId, versionId))!;
  allBlocks = loaded.state.blocks;
  sceneNum = loaded.state.scenes.find(s => s.id === sceneId)!.number;
  expected = computePageMap(loaded.state.blocks, "letter", "compact");
  wrongA4 = computePageMap(loaded.state.blocks, "a4", "center");
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("证人成立", () => {
  it("letter/compact 与 a4/center 的分页确实不同，且跨了多页", () => {
    expect(Math.max(...Object.values(expected))).toBeGreaterThan(2);
    expect(expected).not.toEqual(wrongA4);
  });
});

describe("getEstimatedPageMap", () => {
  it("按演出实际版式取页码，而不是 a4/center", async () => {
    const got = await getEstimatedPageMap(prodId, versionId);
    expect(got).toEqual(expected);
    expect(got).not.toEqual(wrongA4);
  });

  it("读的是 production.page_map 存储（改存储即改结果），缺失时现算兜底", async () => {
    // page_map 按主本（script_view）id 键（#336 B2），不再按版式串
    const masterId = (await getMasterScriptViewId(prodId))!;
    const original = (await loadPageMap(prodId)) ?? {};
    expect(Object.keys(original)).toEqual([masterId]);
    expect(original[masterId]).toEqual(expected);
    try {
      // 篡改存储：证明入口读的是存储而不是每次现算
      await savePageMap(prodId, { ...original, [masterId]: { [blockIds[0]]: 99 } });
      expect(await getEstimatedPageMap(prodId, versionId)).toEqual({ [blockIds[0]]: 99 });
      // 存储里没有该版式 → 现算，结果与算法同源
      await savePageMap(prodId, {});
      expect(await getEstimatedPageMap(prodId, versionId)).toEqual(expected);
    } finally {
      await savePageMap(prodId, original);
    }
  });
});

describe("四个消费点", () => {
  it("GET /api/script/[id]/pages 返回真实版式的页码", async () => {
    const req = new NextRequest(`http://localhost/api/script/${prodId}/pages`, { headers: { cookie: cookie() } });
    const res = await pagesGET(req, ctx() as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { pageMap: Record<string, number> }).pageMap).toEqual(expected);
  });

  it("mention-resolve 的 page 模式按真实版式报页码", async () => {
    // 挑一个两种版式页码不同的块，否则断言分不出新旧
    const witness = blockIds.find(id => expected[id] !== wrongA4[id])!;
    expect(witness).toBeTruthy();
    const page = expected[witness];
    const pos = textIds().filter(id => expected[id] === page).indexOf(witness) + 1;
    const { labels, urls } = await resolve([{ kind: "block", id: witness, displayMode: "page" }]);
    expect(labels[0]).toBe(`#p.${page}-${pos}`);
    expect(urls[0]).toBe(`/production/${prodId}/script?v=${versionId}#block-${witness}`);
  });

  it("block-search 的 p.N- 钻取列出真实版式第 N 页的块", async () => {
    const page = Math.max(...Object.values(expected));
    const onPage = textIds().filter(id => expected[id] === page);
    const { status, results } = await search(`p.${page}-`);
    expect(status).toBe(200);
    expect(results.map(r => r.id)).toEqual(onPage.slice(0, 15));
    expect(results[0].displayLabel).toBe(`#p.${page}-1`);
  });
});

describe("收编野路后的等价性（场 / 排练记号序号与原 SQL 一致）", () => {
  it("block-search 场钻取：按序前 15 块，标签 #场号-序号", async () => {
    const { results } = await search(`${sceneNum}-`);
    expect(results.map(r => r.id)).toEqual(textIds().slice(0, 15));
    expect(results.map(r => r.id)).toEqual(blockIds.slice(0, 15)); // 自动块不在场首
    expect(results[0].displayLabel).toBe(`#${sceneNum}-1`);
  });

  it("block-search 排练记号钻取：只列该记号之后的块，序号从 1 起", async () => {
    const labels = buildMarkerLabelIndex(allBlocks);
    const local = labels.rehearsalLabelByMarkerId.get(rehearsalMarkerId)!;
    const full = labels.labelByMarkerId.get(rehearsalMarkerId)!;
    expect(local).toBeTruthy();
    const under = textIdsUnderMarker(rehearsalMarkerId);
    expect(under.slice(0, 3)).toEqual(blockIds.slice(REHEARSAL_AFTER, REHEARSAL_AFTER + 3));
    const { results } = await search(`${sceneNum}${local}-`);
    expect(results.map(r => r.id)).toEqual(under.slice(0, 15));
    expect(results[0].displayLabel).toBe(`#${full}-1`);
  });

  it("mention-resolve 场 / 记号模式：序号与钻取一致", async () => {
    const index = buildMarkerLabelIndex(allBlocks);
    const full = index.labelByMarkerId.get(rehearsalMarkerId)!;
    // 场首由 makeScene 自动生成的记号：本测试前 10 块挂在它下面
    const autoMarker = allBlocks.find(b => b.type === "rehearsal_marker")!;
    expect(autoMarker.id).not.toBe(rehearsalMarkerId);
    expect(textIdsUnderMarker(autoMarker.id)).toEqual(blockIds.slice(0, REHEARSAL_AFTER));
    const autoFull = index.labelByMarkerId.get(autoMarker.id)!;
    const { labels } = await resolve([
      { kind: "block", id: blockIds[4], displayMode: "scene" },
      { kind: "block", id: blockIds[REHEARSAL_AFTER + 2], displayMode: "rehearsal" },
      { kind: "block", id: blockIds[2], displayMode: "rehearsal" },
      { kind: "block", id: randomUUID(), displayMode: "rehearsal" }, // 不存在的块
      { kind: "rehearsal", id: rehearsalMarkerId },
      { kind: "scene", id: sceneId },
    ]);
    expect(labels).toEqual([`#${sceneNum}-5`, `#${full}-3`, `#${autoFull}-3`, "#[已删除]", `#${full}`, `#${sceneNum}`]);
  });

  it("带冒号的查询不再 500（原「版本名:查询」分支查已 DROP 的 version.name）", async () => {
    const { status } = await search("他说：你好");
    expect(status).toBe(200);
  });
});
