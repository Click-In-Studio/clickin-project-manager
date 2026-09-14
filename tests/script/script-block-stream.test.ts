import { describe, it, expect } from "vitest";
import {
  makeBlock, makeMarkerBlock, isBlockEmptyForDelete, isEmptyTextBlock,
  mergeServerBlocks, stripHtmlText, expandLegacyMarkersToBlocks, sameBlocks, sameMarkerMeta,
  markerSegmentHasScene, insertMarkerWithEmptyBlockIfNeeded, findTocSceneBlockIndex,
  findSceneMarkerBlockIndex, mergeDirtyRanges, markerChangeFromOperations,
} from "@/lib/script/script-block-stream";
import { DEFAULT_SCRIPT_CONFIG, type Block, type Scene, type ScriptState } from "@/lib/script/script-types";

/**
 * 编辑器 block 流的纯函数（#487 S1 从 ScriptEditor.tsx 搬出）。这批逻辑决定「服务端来的
 * 块怎么和本地未保存的编辑合并」「旧版按 sceneId 标记的块怎么展开成 marker 块」——错了
 * 表现是别人的编辑把自己没保存的行盖掉，或者旧剧本打开后章节结构缺失。
 */
function text(id: string, content = "x", extra: Partial<Block> = {}): Block {
  return { ...makeBlock(content), id, ...extra };
}
function marker(id: string, type: "chapter_marker" | "scene_marker" | "rehearsal_marker", sceneId: string | null = null): Block {
  return { ...makeMarkerBlock(type, { sceneId }), id };
}
function state(blocks: Block[]): ScriptState {
  return { blocks, scenes: [], characters: [], config: DEFAULT_SCRIPT_CONFIG };
}

describe("空块判定", () => {
  it("无正文、无舞台提示、无角色、注释全空才算空", () => {
    expect(isBlockEmptyForDelete(text("a", "  "))).toBe(true);
    expect(isBlockEmptyForDelete(text("a", "", { stageComment: "光暗" }))).toBe(false);
    expect(isBlockEmptyForDelete(text("a", "", { characterIds: ["c1"] }))).toBe(false);
    expect(isBlockEmptyForDelete(text("a", "", { characterAnnotations: { c1: "笑" } }))).toBe(false);
  });
  it("marker 块永远不是空文本块", () => {
    expect(isEmptyTextBlock(marker("m", "scene_marker"))).toBe(false);
    expect(isEmptyTextBlock(text("a", ""))).toBe(true);
  });
});

describe("stripHtmlText", () => {
  it("去标签并还原实体", () => {
    expect(stripHtmlText("<b>a&nbsp;&lt;b&gt;</b>&amp;")).toBe("a <b>&");
  });
});

describe("sameBlocks / sameMarkerMeta", () => {
  it("markerMeta 的 undefined 与缺省视为相同", () => {
    expect(sameMarkerMeta(undefined, {})).toBe(true);
    expect(sameMarkerMeta({ name: "一" }, { name: "一", synopsis: undefined })).toBe(true);
    expect(sameMarkerMeta({ name: "一" }, { name: "二" })).toBe(false);
  });
  it("逐字段比较，角色注释按 key 集合比较", () => {
    const a = text("a", "x", { characterIds: ["c1"], characterAnnotations: { c1: "笑" } });
    expect(sameBlocks([a], [{ ...a }])).toBe(true);
    expect(sameBlocks([a], [{ ...a, characterAnnotations: { c1: "哭" } }])).toBe(false);
    expect(sameBlocks([a], [{ ...a, lyric: true }])).toBe(false);
    expect(sameBlocks([a], [])).toBe(false);
  });
});

describe("expandLegacyMarkersToBlocks", () => {
  const scenes: Scene[] = [
    { id: "ch1", number: "一", name: "", parentId: null },
    { id: "sc1", number: "1", name: "", parentId: "ch1" },
  ];
  it("旧版按 sceneId 标记的块展开成章节/段落 marker，块上的 sceneId 清空", () => {
    const out = expandLegacyMarkersToBlocks([text("a", "x", { sceneId: "sc1" }), text("b")], scenes);
    expect(out.map((b) => b.type)).toEqual(["chapter_marker", "scene_marker", "dialogue", "dialogue"]);
    expect(out[0].sceneId).toBe("ch1");
    expect(out[1].sceneId).toBe("sc1");
    expect(out[2].sceneId).toBe(null);
  });
  it("排练记号换值时插 rehearsal_marker，连续同值只插一次", () => {
    const out = expandLegacyMarkersToBlocks([
      text("a", "x", { rehearsalMark: "A" }), text("b", "y", { rehearsalMark: "A" }), text("c", "z", { rehearsalMark: "B" }),
    ]);
    expect(out.map((b) => b.type)).toEqual(["rehearsal_marker", "dialogue", "dialogue", "rehearsal_marker", "dialogue"]);
    expect(out.every((b) => b.rehearsalMark === null)).toBe(true);
  });
  it("已经是 marker 流的不重复展开；纯旧块无标记时原样返回同一引用", () => {
    const already = [marker("m", "chapter_marker", "ch1"), text("a")];
    expect(expandLegacyMarkersToBlocks(already, scenes).filter((b) => b.type === "chapter_marker")).toHaveLength(1);
    const plain = [text("a"), text("b")];
    expect(expandLegacyMarkersToBlocks(plain)).toBe(plain);
  });
});

describe("mergeServerBlocks", () => {
  const synced = state([text("a", "old"), text("b", "b0")]);
  it("本地改过（与上次同步不同）的块赢，没改过的取服务端版本", () => {
    const local = [text("a", "mine"), text("b", "b0")];
    const server = [text("a", "theirs"), text("b", "b1")];
    const out = mergeServerBlocks(local, server, synced);
    expect(out.map((b) => b.content)).toEqual(["mine", "b1"]);
  });
  it("本地顺序未动时服务端顺序为准，服务端新块进来", () => {
    const local = [text("a", "old"), text("b", "b0")];
    const server = [text("b", "b0"), text("a", "old"), text("s", "srv")];
    const out = mergeServerBlocks(local, server, synced);
    expect(out.map((b) => b.id)).toEqual(["b", "a", "s"]);
  });
  it("服务端删掉了本地改过的块：本地顺序未动时该块仍保留在末尾", () => {
    const local = [text("a", "mine"), text("b", "b0")];
    const server = [text("b", "b0")];
    const out = mergeServerBlocks(local, server, synced);
    expect(out.map((b) => b.id)).toEqual(["b", "a"]);
    expect(out[1].content).toBe("mine");
  });
  it("本地有未同步的新块或重排过 → 本地顺序为准，服务端多出的块追加在末尾", () => {
    const reordered = mergeServerBlocks([text("b", "b0"), text("a", "old")], [text("a", "old"), text("b", "b0"), text("s", "srv")], synced);
    expect(reordered.map((b) => b.id)).toEqual(["b", "a", "s"]);
    const withNew = mergeServerBlocks([text("a", "old"), text("n", "new"), text("b", "b0")], [text("b", "b0"), text("a", "old")], synced);
    expect(withNew.map((b) => b.id)).toEqual(["a", "n", "b"]);
  });
  it("没有同步基线时一切本地块都算脏", () => {
    const out = mergeServerBlocks([text("a", "mine")], [text("a", "theirs")], null);
    expect(out[0].content).toBe("mine");
  });
});

describe("marker 段", () => {
  const blocks = [
    marker("c1", "chapter_marker", "ch1"), text("t1"),
    marker("s1", "scene_marker", "sc1"), text("t2"),
    marker("c2", "chapter_marker", "ch2"), text("t3"),
  ];
  it("markerSegmentHasScene：章节到下一章节之间有没有段落", () => {
    expect(markerSegmentHasScene(blocks, 0)).toBe(true);
    expect(markerSegmentHasScene(blocks, 4)).toBe(false);
  });
  it("insertMarkerWithEmptyBlockIfNeeded：紧贴在另一个 marker 后插入会补一个空文本块，插入位置越界被夹住", () => {
    const out = insertMarkerWithEmptyBlockIfNeeded(blocks, marker("s2", "scene_marker", "sc2"), 1, null);
    const i = out.findIndex((b) => b.id === "s2");
    expect(i).toBe(1);
    expect(out[i + 1].type).toBe("dialogue");
    expect(out[i + 1].id).toBe("t1");
    const tail = insertMarkerWithEmptyBlockIfNeeded(blocks, marker("s3", "scene_marker", "sc3"), 999, null);
    expect(tail.at(-2)?.id).toBe("s3");
    expect(isEmptyTextBlock(tail.at(-1)!)).toBe(true);
  });
  it("findSceneMarkerBlockIndex / findTocSceneBlockIndex：章节没有自己的块时落到第一个子段落", () => {
    expect(findSceneMarkerBlockIndex("sc1", blocks)).toBe(2);
    expect(findSceneMarkerBlockIndex("ghost", blocks)).toBe(-1);
    const scenes: Scene[] = [
      { id: "ch", number: "一", name: "", parentId: null },
      { id: "sc", number: "1", name: "", parentId: "ch" },
    ];
    const legacy = [text("a", "x", { sceneId: "sc" })];
    expect(findTocSceneBlockIndex("ch", scenes, legacy)).toBe(0);
    expect(findTocSceneBlockIndex("sc", scenes, legacy)).toBe(0);
    expect(findTocSceneBlockIndex("none", scenes, legacy)).toBe(-1);
  });
});

describe("dirty 区间 / marker 变更", () => {
  it("mergeDirtyRanges：任一方 full 即 full，否则区间拼接", () => {
    expect(mergeDirtyRanges("full", { start: 0, end: 1 })).toBe("full");
    expect(mergeDirtyRanges(null, "full")).toBe("full");
    expect(mergeDirtyRanges({ start: 0, end: 1 }, [{ start: 3, end: 4 }])).toEqual([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  });
  it("markerChangeFromOperations：位置去重排序，前后任一类型是 marker 即结构变更", () => {
    const change = markerChangeFromOperations([
      { kind: "structure", position: 3, blockId: "b", beforeType: "dialogue", afterType: "dialogue" },
      { kind: "structure", position: 1, blockId: "a", beforeType: "dialogue", afterType: "scene_marker" },
      { kind: "structure", position: 3, blockId: "b", beforeType: "dialogue", afterType: "dialogue" },
    ]);
    expect(change.positions).toEqual([1, 3]);
    expect(change.markerStructureChanged).toBe(true);
    expect(markerChangeFromOperations([]).markerStructureChanged).toBe(false);
  });
});
