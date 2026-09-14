import { describe, it, expect } from "vitest";
import { analyzeEmptyScriptCleanup, buildEmptyScriptCleanupRemovalPlan, isOnlyTextBlockInMarkerSegment } from "@/lib/script/script-empty-cleanup";
import { makeBlock, makeMarkerBlock } from "@/lib/script/script-block-stream";
import { toSceneDetail } from "@/lib/script/script-scene-details";
import type { Block, Scene } from "@/lib/script/script-types";
import type { SceneDetail } from "@/lib/db";

/**
 * 「清理空剧本结构」的分析与删除计划（#487 S1 从 ScriptEditor.tsx 搬出）。
 * 规则：没有正文的段落可删；章节要自己没正文且子段落全可删才可删；开场章节默认不动；
 * 详情不为空的段落禁删，并把禁删原因上提到父章节。
 */
function text(id: string, content = "x"): Block { return { ...makeBlock(content), id }; }
function marker(id: string, type: "chapter_marker" | "scene_marker" | "rehearsal_marker", sceneId: string | null = null): Block {
  return { ...makeMarkerBlock(type, { sceneId }), id };
}
const scenes: Scene[] = [
  { id: "ch1", number: "一", name: "开场", parentId: null },
  { id: "sc1", number: "1", name: "", parentId: "ch1" },
  { id: "sc2", number: "2", name: "", parentId: "ch1" },
  { id: "ch2", number: "二", name: "", parentId: null },
];
const details = (patch: Partial<Record<string, Partial<SceneDetail>>> = {}) =>
  new Map(scenes.map((s) => [s.id, { ...toSceneDetail(s), ...(patch[s.id] ?? {}) }]));

const blocks = [
  marker("c1", "chapter_marker", "ch1"),
  marker("s1", "scene_marker", "sc1"), text("t1"),
  marker("s2", "scene_marker", "sc2"), text("e1", ""),
  marker("r1", "rehearsal_marker"), text("e2", ""),
  marker("c2", "chapter_marker", "ch2"), text("e3", ""),
];

describe("analyzeEmptyScriptCleanup", () => {
  it("无正文的段落 / 排练记号 / 章节成为目标；有正文的不进；开场章节默认不进", () => {
    const { targets, hasEmptyTextBlock } = analyzeEmptyScriptCleanup(blocks, scenes, details(), "c1");
    expect(targets.map((t) => t.key)).toEqual(["scene:sc2", "rehearsal:r1", "chapter:ch2"]);
    expect(hasEmptyTextBlock).toBe(true);
    expect(targets.find((t) => t.key === "rehearsal:r1")?.parentKey).toBe("scene:sc2");
  });
  it("includeOpeningChapter 时开场章节也可成为目标——但它有子段落有正文，仍不可删", () => {
    const { targets } = analyzeEmptyScriptCleanup(blocks, scenes, details(), "c1", { includeOpeningChapter: true });
    expect(targets.some((t) => t.key === "chapter:ch1")).toBe(false);
    // 子段落按 scenes 表算，不按块算：表里还挂着 sc1/sc2 的章节即使块里空了也不可删
    const onlyEmpty = [marker("c1", "chapter_marker", "ch1"), text("e", "")];
    expect(analyzeEmptyScriptCleanup(onlyEmpty, scenes, details(), "c1", { includeOpeningChapter: true }).targets).toEqual([]);
    const lone: Scene[] = [{ id: "ch1", number: "一", name: "开场", parentId: null }];
    const opening = analyzeEmptyScriptCleanup(onlyEmpty, lone, new Map([["ch1", toSceneDetail(lone[0])]]), "c1", { includeOpeningChapter: true });
    expect(opening.targets.map((t) => t.key)).toEqual(["chapter:ch1"]);
    expect(analyzeEmptyScriptCleanup(onlyEmpty, lone, new Map([["ch1", toSceneDetail(lone[0])]]), "c1").targets).toEqual([]);
  });
  it("详情不为空的段落禁删，原因上提到父章节", () => {
    const withDetail = [
      marker("c2", "chapter_marker", "ch2"),
      marker("s1", "scene_marker", "sc1"), text("e", ""),
    ];
    const localScenes: Scene[] = [
      { id: "ch2", number: "二", name: "", parentId: null },
      { id: "sc1", number: "1", name: "", parentId: "ch2" },
    ];
    const map = new Map(localScenes.map((s) => [s.id, { ...toSceneDetail(s), ...(s.id === "sc1" ? { synopsis: "有内容" } : {}) }]));
    const { targets } = analyzeEmptyScriptCleanup(withDetail, localScenes, map, null);
    const scene = targets.find((t) => t.key === "scene:sc1")!;
    const chapter = targets.find((t) => t.key === "chapter:ch2")!;
    expect(scene.disabledReason).toBe("段落详情不为空");
    expect(chapter.disabledReason).toBe("子段落详情不为空：1");
  });
});

describe("buildEmptyScriptCleanupRemovalPlan", () => {
  it("选中段落 → 段落 marker 及其下所有块（含排练记号）删除；未选中段落只删空文本块", () => {
    const { targets } = analyzeEmptyScriptCleanup(blocks, scenes, details(), "c1");
    const plan = buildEmptyScriptCleanupRemovalPlan(blocks, targets.filter((t) => t.key === "scene:sc2"));
    expect([...plan.deleteBlockIds].sort()).toEqual(["e1", "e2", "e3", "r1", "s2"]);
    expect([...plan.selectedSceneIds]).toEqual(["sc2"]);
  });
  it("只选排练记号 → 记号与其后到下一 marker 的块删除", () => {
    const { targets } = analyzeEmptyScriptCleanup(blocks, scenes, details(), "c1");
    const plan = buildEmptyScriptCleanupRemovalPlan(blocks, targets.filter((t) => t.key === "rehearsal:r1"));
    expect(plan.deleteBlockIds.has("r1")).toBe(true);
    expect(plan.deleteBlockIds.has("s2")).toBe(false);
  });
});

describe("isOnlyTextBlockInMarkerSegment", () => {
  it("段内唯一文本块为真；段内多块、marker 本身、开场章节无段落的段为假", () => {
    expect(isOnlyTextBlockInMarkerSegment(blocks, 2, "c1")).toBe(true);   // t1 在 sc1 段里独一个
    expect(isOnlyTextBlockInMarkerSegment(blocks, 1, "c1")).toBe(false);  // marker
    const two = [marker("s", "scene_marker", "sc1"), text("a"), text("b")];
    expect(isOnlyTextBlockInMarkerSegment(two, 1, null)).toBe(false);
    const opening = [marker("c", "chapter_marker", "ch1"), text("a")];
    expect(isOnlyTextBlockInMarkerSegment(opening, 1, "c")).toBe(false);
    expect(isOnlyTextBlockInMarkerSegment(opening, 1, null)).toBe(true);
  });
});
