import { describe, it, expect } from "vitest";
import {
  isSceneBoundaryBlock,
  isTextBlock,
  sameCharacters,
  shouldHideCharacterLabel,
  shouldShowCharacterGap,
  shouldShowSceneEndGap,
} from "@/lib/script-block-layout";
import type { Block, BlockType } from "@/lib/script-types";

/**
 * 块级排版判据的护栏（#335 抽出为共用件时补）。
 *
 * 这些判据现在被**两条渲染路径**吃：编辑器正文渲染与打印分页。任何一条分歧
 * 都会直接变成「屏上分页与纸上分页不一致」——而它们原先埋在 ScriptEditor 内部，
 * 从来没有测试。
 *
 * 另外 `shouldHideCharacterLabel` 是 #340（规则引擎）的迁移靶子：那一步要求
 * 「把今天硬编码的规则搬进引擎、输出逐字不变」，这组断言就是那个"逐字不变"的定义。
 */
function block(patch: Partial<Block> & { type?: BlockType } = {}): Block {
  return {
    id: "b1",
    type: "dialogue",
    content: "",
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: "s1",
    rehearsalMark: null,
    ...patch,
  };
}

describe("sameCharacters", () => {
  it("同一组角色（顺序不同）判为相同", () => {
    expect(sameCharacters(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("长度不同判为不同", () => {
    expect(sameCharacters(["a"], ["a", "b"])).toBe(false);
  });

  it("重复 id 不能判成相同——集合比会漏掉这一条", () => {
    // 旧实现 new Set(a) + b.every(...)：a 的集合是 {x,y}，b 的每个元素都在里面，
    // 长度又相等，于是判成"同一组角色"，角色名被错误省略。
    expect(sameCharacters(["x", "y"], ["x", "x"])).toBe(false);
    expect(sameCharacters(["x", "x"], ["x", "y"])).toBe(false);
  });
});

describe("shouldHideCharacterLabel", () => {
  const prev = block({ id: "p", characterIds: ["c1"], rehearsalMark: "A" });

  it("连续同角色 + 同场次 + 同排练记号 → 省略角色名", () => {
    expect(shouldHideCharacterLabel(prev, block({ characterIds: ["c1"], rehearsalMark: "A" }))).toBe(true);
  });

  it("换场次 → 不省略（跨场要重新亮出角色名）", () => {
    expect(shouldHideCharacterLabel(prev, block({ characterIds: ["c1"], rehearsalMark: "A", sceneId: "s2" }))).toBe(false);
  });

  it("换排练记号 → 不省略", () => {
    expect(shouldHideCharacterLabel(prev, block({ characterIds: ["c1"], rehearsalMark: "B" }))).toBe(false);
  });

  it("换角色 → 不省略", () => {
    expect(shouldHideCharacterLabel(prev, block({ characterIds: ["c2"], rehearsalMark: "A" }))).toBe(false);
  });

  it("forceShowCharacterName 一票否决", () => {
    expect(shouldHideCharacterLabel(prev, block({
      characterIds: ["c1"], rehearsalMark: "A", forceShowCharacterName: true,
    }))).toBe(false);
  });

  it("没有前一块（本页/本剧开头）→ 不省略", () => {
    expect(shouldHideCharacterLabel(null, block({ characterIds: ["c1"] }))).toBe(false);
  });

  it("前一块是舞台指示 → 不省略", () => {
    expect(shouldHideCharacterLabel(
      block({ id: "p", type: "stage" }),
      block({ characterIds: ["c1"] }),
    )).toBe(false);
  });
});

describe("shouldShowCharacterGap", () => {
  it("舞台指示前留空——但连续舞台指示之间不留", () => {
    expect(shouldShowCharacterGap(block({ id: "p" }), block({ type: "stage" }), false)).toBe(true);
    expect(shouldShowCharacterGap(block({ id: "p", type: "stage" }), block({ type: "stage" }), false)).toBe(false);
  });

  it("有角色且角色名没被省略 → 留空", () => {
    expect(shouldShowCharacterGap(block({ id: "p" }), block({ characterIds: ["c1"] }), false)).toBe(true);
  });

  it("角色名被省略 → 不留空（省略的目的就是让它接着上一句）", () => {
    expect(shouldShowCharacterGap(block({ id: "p" }), block({ characterIds: ["c1"] }), true)).toBe(false);
  });

  it("无角色的对白：同场次同记号的连续无角色块之间不留空", () => {
    const prev = block({ id: "p", characterIds: [], rehearsalMark: "A" });
    expect(shouldShowCharacterGap(prev, block({ characterIds: [], rehearsalMark: "A" }), false)).toBe(false);
    expect(shouldShowCharacterGap(prev, block({ characterIds: [], rehearsalMark: "B" }), false)).toBe(true);
  });

  it("没有前一块 → 不留空", () => {
    expect(shouldShowCharacterGap(null, block({ characterIds: ["c1"] }), false)).toBe(false);
  });
});

describe("isSceneBoundaryBlock / shouldShowSceneEndGap / isTextBlock", () => {
  it("章节 / 场次 marker 自身是场次边界", () => {
    expect(isSceneBoundaryBlock(block({ type: "chapter_marker" }), null)).toBe(true);
    expect(isSceneBoundaryBlock(block({ type: "scene_marker" }), null)).toBe(true);
  });

  it("普通块换了 sceneId 才算边界", () => {
    expect(isSceneBoundaryBlock(block({ sceneId: "s2" }), block({ id: "p", sceneId: "s1" }))).toBe(true);
    expect(isSceneBoundaryBlock(block({ sceneId: "s1" }), block({ id: "p", sceneId: "s1" }))).toBe(false);
  });

  it("marker 之后紧跟的块不再算边界（边界已由 marker 表达）", () => {
    expect(isSceneBoundaryBlock(block({ sceneId: "s2" }), block({ id: "p", type: "scene_marker" }))).toBe(false);
  });

  it("场末留空只在进入 marker 时出现", () => {
    expect(shouldShowSceneEndGap(block({ id: "p" }), block({ type: "chapter_marker" }))).toBe(true);
    expect(shouldShowSceneEndGap(block({ id: "p" }), block({ type: "dialogue" }))).toBe(false);
  });

  it("marker 不是正文块", () => {
    expect(isTextBlock(block({ type: "dialogue" }))).toBe(true);
    expect(isTextBlock(block({ type: "scene_marker" }))).toBe(false);
  });
});
