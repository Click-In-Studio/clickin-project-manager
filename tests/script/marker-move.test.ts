import { describe, expect, it } from "vitest";
import { moveHierarchyMarker, normalizeScriptMarkerInvariants } from "../../lib/script/script-marker-domain";
import { DEFAULT_SCRIPT_CONFIG, type Block, type ScriptState } from "../../lib/script/script-types";

let n = 0;
const createId = () => `g${++n}`;

function block(id: string, type: Block["type"], content = ""): Block {
  return {
    id,
    type,
    content,
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: type.endsWith("_marker") ? id : null,
    rehearsalMark: null,
    forceShowCharacterName: false,
  };
}

const raw: ScriptState = {
  blocks: [
    block("c0", "chapter_marker"),
    block("s01", "scene_marker"),
    block("t01", "dialogue", "a"),
    block("c1", "chapter_marker"),
    block("s11", "scene_marker"),
    block("t11", "dialogue", "b"),
    block("s12", "scene_marker"),
    block("t12", "dialogue", "c"),
    block("c2", "chapter_marker"),
    block("s21", "scene_marker"),
    block("t21", "dialogue", "d"),
  ],
  scenes: [],
  characters: [],
  config: { ...DEFAULT_SCRIPT_CONFIG, openingChapterMarkerId: "c0" },
};

const base = normalizeScriptMarkerInvariants(raw, createId);
const ids = (state: ScriptState) => state.blocks.map((item) => item.id).join(",");
const parent = (state: ScriptState, id: string) => state.blocks.find((item) => item.id === id)?.markerMeta?.parentMarkerId;

describe("moveHierarchyMarker", () => {
  it("段落在章内上移", () => {
    expect(ids(moveHierarchyMarker(base, "s12", "s11", createId))).toBe("c0,s01,t01,c1,s12,t12,s11,t11,c2,s21,t21");
  });

  it("段落经「下一章边界」移到章末，parent 不变", () => {
    const result = moveHierarchyMarker(base, "s11", "c2", createId);
    expect(ids(result)).toBe("c0,s01,t01,c1,s12,t12,s11,t11,c2,s21,t21");
    expect(parent(result, "s11")).toBe("c1");
  });

  it("跨章移动被拒", () => {
    expect(moveHierarchyMarker(base, "s11", "s21", createId)).toBe(base);
    expect(moveHierarchyMarker(base, "s21", "c2", createId)).toBe(base);
  });

  it("整章带段落和正文一起前移", () => {
    expect(ids(moveHierarchyMarker(base, "c2", "c1", createId))).toBe("c0,s01,t01,c2,s21,t21,c1,s11,t11,s12,t12");
  });

  it("整章移到末尾", () => {
    expect(ids(moveHierarchyMarker(base, "c1", null, createId))).toBe("c0,s01,t01,c2,s21,t21,c1,s11,t11,s12,t12");
  });

  it("原位放置返回同一 state", () => {
    expect(moveHierarchyMarker(base, "c1", "c2", createId)).toBe(base);
    expect(moveHierarchyMarker(base, "s11", "s12", createId)).toBe(base);
    expect(moveHierarchyMarker(base, "s21", null, createId)).toBe(base);
  });

  it("开场章不可移动", () => {
    expect(moveHierarchyMarker(base, "c0", null, createId)).toBe(base);
  });

  it("别的章也插不到开场章之前", () => {
    // 开场章是「排在最前的那一章」派生的：真让 c2 插到 c0 前面，规范化会把
    // openingChapterMarkerId 重指成 c2，编号 0 就跳到第二章头上了。
    expect(moveHierarchyMarker(base, "c2", "c0", createId)).toBe(base);
    expect(moveHierarchyMarker(base, "c1", "c0", createId)).toBe(base);
  });
});
