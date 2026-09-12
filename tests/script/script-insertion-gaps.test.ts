import { describe, expect, it } from "vitest";
import { hasScriptInsertionGapBefore, sceneParentIdMap } from "@/lib/script-insertion-gaps";
import type { Block, Scene } from "@/lib/script-types";

function block(id: string, type: Block["type"], sceneId: string | null = null): Block {
  return {
    id,
    type,
    content: "",
    stageComment: null,
    lyric: false,
    characterIds: [],
    characterAnnotations: {},
    sceneId,
    rehearsalMark: null,
  };
}

describe("shared script insertion gaps", () => {
  const scenes = [
    { id: "chapter", number: "1", name: "第一章", parentId: null },
    { id: "scene", number: "1-1", name: "第一场", parentId: "chapter" },
  ] satisfies Scene[];
  const parents = sceneParentIdMap(scenes);

  it("does not expose an insertion gap before the first block", () => {
    expect(hasScriptInsertionGapBefore([block("first", "dialogue")], 0, parents)).toBe(false);
  });

  it("exposes ordinary gaps before markers and text blocks", () => {
    const blocks = [block("a", "dialogue"), block("b", "chapter_marker", "chapter"), block("c", "dialogue")];
    expect(hasScriptInsertionGapBefore(blocks, 1, parents)).toBe(true);
    expect(hasScriptInsertionGapBefore(blocks, 2, parents)).toBe(true);
  });

  it("protects only an immediate chapter-to-own-child-scene gap", () => {
    const ownChild = [block("chapter", "chapter_marker", "chapter"), block("scene", "scene_marker", "scene")];
    const unrelated = [block("other", "chapter_marker", "other"), block("scene", "scene_marker", "scene")];
    expect(hasScriptInsertionGapBefore(ownChild, 1, parents)).toBe(false);
    expect(hasScriptInsertionGapBefore(unrelated, 1, parents)).toBe(true);
  });
});
