import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { loadProduction } from "@/lib/script/script-state-db";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { savePageMap, scheduleEstimatedPageMapSave } from "@/lib/script/page-map-db";
import { loadScriptReadStructure, loadScriptReadBlocks } from "@/lib/script/script-local-read-db";
import { searchScriptBlockMatches, searchScriptTextHits } from "@/lib/script/script-search-db";
import { scriptReadPage, scriptReadSection, scriptReadWindow, scriptSearch } from "@/lib/agent/tools/script-tools";
import { GET as blockSearch } from "@/app/api/production/[id]/script/block-search/route";
import { loadCueExportContext } from "@/lib/ops/cue-export-db";
import { formatCuePosition } from "@/lib/ops/cue-export";
import { withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script/script-marker-blocks";
import type { Block } from "@/lib/script/script-types";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";
import { cleanupProduction, makeCharacter, makeProduction, makeScene, shortId } from "../_support/factories";

let prodId: string, versionId: string, owner: string, chapter: string, otherChapter: string;
let speaker: string, secondSpeaker: string;
const a = shortId(), b = shortId(), c = shortId(), marker = shortId(), outside = shortId();
const SECRET = "不应装载的其他章节正文";
let canonical: Block[];
let emptyProdId: string, emptyVersionId: string;

async function insert(id: string, content: string, afterId: string, extra: Partial<Block> = {}) {
  await applyPatchToDB(prodId, versionId, {
    clientSeq: 1, charOps: [], sceneOps: [],
    blockOps: [{ op: "insert", afterId, block: {
      id, content, type: "dialogue", lyric: false, sceneId: null, rehearsalMark: null,
      characterIds: [], characterAnnotations: {}, ...extra,
    } }],
  });
}

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  owner = (await getPool().query<{ owner_id: string }>("SELECT owner_id FROM production WHERE id = $1", [prodId])).rows[0].owner_id;
  chapter = await makeScene(prodId, versionId, { name: "目标章" });
  speaker = await makeCharacter(prodId, versionId, { name: "同名角色" });
  secondSpeaker = await makeCharacter(prodId, versionId, { name: "同名角色" });
  await insert(a, "AbC 中文 100% _ \\", chapter, { characterIds: [speaker, secondSpeaker], stageComment: "AbC 提示" });
  await insert(marker, "", a, { type: "rehearsal_marker" });
  await insert(b, "只命中舞台提示", marker, { characterIds: [speaker], stageComment: "ABC 注释" });
  await insert(c, "AbC 第三处 <b>样式</b>", b);
  otherChapter = await makeScene(prodId, versionId, { name: "其他章" });
  await insert(outside, SECRET, otherChapter);
  canonical = withLegacyOwnershipProjection(withMarkerOwnership((await loadProduction(prodId, versionId))!.state.blocks));
  await scheduleEstimatedPageMapSave(prodId, versionId, "full");
  const viewId = (await getPool().query<{ master_view_id: string }>("SELECT master_view_id FROM production WHERE id = $1", [prodId])).rows[0].master_view_id;
  await savePageMap(prodId, { [viewId]: { [a]: 1, [b]: 1, [c]: 2, [outside]: 3 } });
  ({ prodId: emptyProdId, versionId: emptyVersionId } = await makeProduction(owner));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(emptyProdId).catch(() => {});
});

/** 观察真实 PG 返回的数据，不能只断言最终输出不含其他正文（全本过滤也能通过）。 */
async function withoutOutsideBody<T>(work: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(getPool(), "query");
  try {
    const result = await work();
    const returned = await Promise.all(spy.mock.results.filter(item => item.type === "return").map(item => item.value as unknown as Promise<{ rows: unknown[] }>));
    expect(JSON.stringify(returned.map(item => item?.rows))).not.toContain(SECRET);
    return result;
  } finally { spy.mockRestore(); }
}

describe("结构与局部正文同源", () => {
  it("结构只带 marker 内容；局部块保留窗口之前的章/排练语境", async () => {
    const structure = await withoutOutsideBody(() => loadScriptReadStructure(versionId));
    expect(structure.byId.get(outside)?.content).toBe("");
    const selected = await withoutOutsideBody(() => loadScriptReadBlocks(versionId, structure, [b, c]));
    expect(selected).toEqual(canonical.filter(block => block.id === b || block.id === c));
    expect(selected[0]).toMatchObject({ sceneId: chapter, rehearsalMark: marker });
  });

  it("窗口正文只装目标块；未出现在窗口中的同名角色仍用 id 序列化", async () => {
    const output = await withoutOutsideBody(() => scriptReadWindow(owner, prodId, b, 0, 0));
    expect(output).toContain(`[b:${b}] #${speaker}：只命中舞台提示`);
    expect(output).toContain("目标章");
    expect(output).toContain(`继续向前：以 [b:${marker}]`);
    expect(output).not.toContain(`[b:${a}]`);
  });

  it("按页保留首尾正文之间的 marker；按段不加载其他章节正文", async () => {
    const page = await withoutOutsideBody(() => scriptReadPage(owner, prodId, 1));
    expect(page).toContain(`[m:${marker}]`);
    expect(page).toContain(`[b:${a}]`);
    expect(page).toContain(`[b:${b}]`);
    expect(page).not.toContain(`[b:${c}]`);
    const section = await withoutOutsideBody(() => scriptReadSection(owner, prodId, chapter));
    expect(section).toContain(`[b:${c}]`);
    expect(section).not.toContain(`[m:${otherChapter}]`);
  });

  it("空剧本、缺失锚点与窗口首尾保持原有响应", async () => {
    const empty = "（剧本还没有任何正文块）";
    expect(await scriptReadWindow(owner, emptyProdId, "missing")).toBe(empty);
    expect(await scriptReadSection(owner, emptyProdId, "missing")).toBe(empty);
    expect(await scriptReadPage(owner, emptyProdId, 1)).toBe(empty);
    expect(await scriptSearch(owner, emptyProdId, { query: "abc" })).toBe(empty);
    expect(await searchScriptBlockMatches(emptyVersionId, "abc", false)).toEqual([]);
    expect(await searchScriptTextHits(emptyVersionId, "abc", null, 10)).toEqual({ total: 0, hits: [] });
    expect(await withoutOutsideBody(() => scriptReadWindow(owner, prodId, "missing"))).toContain("没有找到该块");
    const first = await scriptReadWindow(owner, prodId, canonical[0].id, 50, 0);
    expect(first).toContain("已到剧本开头");
    const last = await scriptReadWindow(owner, prodId, canonical.at(-1)!.id, 0, 50);
    expect(last).toContain("已到剧本结尾");
  });
});

describe("数据库搜索契约", () => {
  it("正文优先、单块计一次，多角色过滤不重复，总数不受 limit 影响", async () => {
    const result = await withoutOutsideBody(() => searchScriptTextHits(versionId, "abc", [speaker, secondSpeaker], 1));
    expect(result.total).toBe(2);
    expect(result.hits).toEqual([{ id: a, index: canonical.findIndex(block => block.id === a), from: "content" }]);
    const all = await searchScriptTextHits(versionId, "abc", null, 30);
    expect(all.total).toBe(3);
    expect(all.hits.map(hit => [hit.id, hit.from])).toEqual([[a, "content"], [b, "stageComment"], [c, "content"]]);
    const output = await withoutOutsideBody(() => scriptSearch(owner, prodId, { query: "abc", limit: 1 }));
    expect(output).toContain("共命中 3 处（显示前 1 条）");
    expect(output).toContain(`[b:${a}]`);
    expect(output).not.toContain(`[b:${b}]`);
  });

  it("正文搜索把 %、_、反斜杠当字面量，编辑器保留 HTML 与大小写口径", async () => {
    for (const query of ["100%", "_", "\\"]) {
      expect((await searchScriptBlockMatches(versionId, query, false)).map(hit => hit.id)).toEqual([a]);
      expect((await searchScriptTextHits(versionId, query, null, 10)).hits.map(hit => hit.id)).toEqual([a]);
    }
    expect((await searchScriptBlockMatches(versionId, "样式", false)).map(hit => hit.id)).toEqual([c]);
    expect(await searchScriptBlockMatches(versionId, "<b>", false)).toEqual([]);
    expect((await searchScriptTextHits(versionId, "<b>", null, 10)).hits.map(hit => hit.id)).toEqual([c]);
    expect(await searchScriptBlockMatches(versionId, "ABC", true)).toEqual([]);
    expect((await searchScriptBlockMatches(versionId, "abc", false)).map(hit => hit.id)).toEqual([a, c]);
    expect(await searchScriptTextHits(versionId, "不匹配", null, 10)).toEqual({ total: 0, hits: [] });
  });

  it("场候选不读取正文，展开候选才读取目标摘要", async () => {
    const structure = await loadScriptReadStructure(versionId);
    const label = structure.labels.labelByMarkerId.get(chapter)!;
    const query = async (q: string) => {
      const response = await blockSearch(new NextRequest(`http://localhost/api/production/${prodId}/script/block-search?q=${encodeURIComponent(q)}`, {
        headers: { cookie: `${SESSION_COOKIE}=${createSession({ userId: owner, name: "owner", avatarUrl: null, isAdmin: false })}` },
      }), { params: Promise.resolve({ id: prodId }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const candidates = await withoutOutsideBody(() => query("目标章"));
    expect(candidates.results[0].id).toBe(chapter);
    const drill = await withoutOutsideBody(() => query(`${label}-`));
    expect(drill.results.some((result: { id: string; description?: string }) => result.id === a && result.description?.includes("AbC"))).toBe(true);
  });
});

describe("Cue 导出只取锚点与 gap 邻块", () => {
  function cue(start: CueAnchor, end: CueAnchor = start): Cue {
    return { id: shortId(), cueId: shortId(), cueListId: "test", number: "1", name: "", content: "", warning: false, start, end };
  }

  it("gap 不误取下一条被选中的远处锚点，顺序按全本正文序列", async () => {
    const gap = cue({ kind: "gap", afterBlockId: a });
    const context = await withoutOutsideBody(() => loadCueExportContext(versionId, [gap]));
    const expectedNext = canonical.filter(block => !["chapter_marker", "scene_marker", "rehearsal_marker"].includes(block.type));
    const next = expectedNext[expectedNext.findIndex(block => block.id === a) + 1];
    expect(context.nextBlockIdById.get(a)).toBe(next.id);
    expect(context.blockMap.has(c)).toBe(false);
    const text = formatCuePosition(gap, context).map(part => part.text).join("");
    expect(text).toContain(" ↓ ");
    expect(text).toContain(next.content.slice(0, 15));
  });

  it("单点、同块范围、跨块范围、缺失锚点、首尾 gap 保留文案", async () => {
    const cues = [
      cue({ kind: "block", blockId: a, offset: 3 }),
      cue({ kind: "block", blockId: a, offset: 0 }, { kind: "block", blockId: a, offset: 3 }),
      cue({ kind: "block", blockId: a, offset: 3 }, { kind: "block", blockId: b, offset: 2 }),
      cue({ kind: "block", blockId: "missing", offset: 0 }),
      cue({ kind: "gap", afterBlockId: null }),
      cue({ kind: "gap", afterBlockId: "missing" }),
      cue({ kind: "block", blockId: a, offset: 3 }, { kind: "gap", afterBlockId: a }),
    ];
    const context = await withoutOutsideBody(() => loadCueExportContext(versionId, cues));
    expect(formatCuePosition(cues[0], context).some(part => part.text === " " && part.underline)).toBe(true);
    expect(formatCuePosition(cues[1], context).some(part => part.text === "AbC" && part.underline)).toBe(true);
    expect(formatCuePosition(cues[2], context).map(part => part.text).join("")).toContain(" → ");
    expect(formatCuePosition(cues[3], context)).toEqual([{ text: "（位置缺失）" }]);
    expect(formatCuePosition(cues[4], context)).toEqual([{ text: " ↓ " }]);
    expect(formatCuePosition(cues[5], context)).toEqual([{ text: " ↓ " }]);
    expect(formatCuePosition(cues[6], context).map(part => part.text).join("")).toContain(" → ");
    const tailGap = cue({ kind: "gap", afterBlockId: canonical.at(-1)!.id });
    const tailContext = await loadCueExportContext(versionId, [tailGap]);
    expect(formatCuePosition(tailGap, tailContext).at(-1)).toEqual({ text: " ↓ " });
  });
});
