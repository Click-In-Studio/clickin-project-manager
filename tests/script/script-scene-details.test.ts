import { describe, it, expect } from "vitest";
import {
  hasNonNameSceneDetails, markerBlockDramaturgyDeleteBlockedKind, buildOrderedTocScenes,
  syncSceneDetailsWithScenes, toSceneDetail, sameSceneRows, computeLyricFromTags,
} from "@/lib/script/script-scene-details";
import { makeBlock, makeMarkerBlock } from "@/lib/script/script-block-stream";
import type { Block, Scene } from "@/lib/script/script-types";
import type { TagGroup } from "@/lib/db";

/** 场次详情 / TOC 顺序的纯函数（#487 S1 从 ScriptEditor.tsx 搬出）。 */
const scenes: Scene[] = [
  { id: "ch1", number: "一", name: "", parentId: null },
  { id: "sc1", number: "1", name: "", parentId: "ch1" },
  { id: "sc2", number: "2", name: "", parentId: "ch1" },
  { id: "ch2", number: "二", name: "", parentId: null },
];
const text = (id: string, sceneId: string | null = null): Block => ({ ...makeBlock("x"), id, sceneId });

describe("hasNonNameSceneDetails / 删除阻断", () => {
  it("详情或 markerMeta 任一非空字段即为真；章节忽略 expectedDuration", () => {
    expect(hasNonNameSceneDetails(null, null)).toBe(false);
    expect(hasNonNameSceneDetails({ synopsis: " " }, null)).toBe(false);
    expect(hasNonNameSceneDetails(null, { music: "序曲" })).toBe(true);
    expect(hasNonNameSceneDetails({ expectedDuration: "5m" }, null, true)).toBe(false);
    expect(hasNonNameSceneDetails({ expectedDuration: "5m" }, null, false)).toBe(true);
  });
  it("markerBlockDramaturgyDeleteBlockedKind：只对章节/段落 marker 判定，返回其种类", () => {
    const ch = { ...makeMarkerBlock("chapter_marker", { sceneId: "ch1" }), markerMeta: { synopsis: "有" } };
    expect(markerBlockDramaturgyDeleteBlockedKind(ch, null)).toBe("chapter");
    expect(markerBlockDramaturgyDeleteBlockedKind(makeMarkerBlock("scene_marker"), null)).toBe(null);
    expect(markerBlockDramaturgyDeleteBlockedKind(makeMarkerBlock("rehearsal_marker"), { ...toSceneDetail(scenes[0]), synopsis: "有" })).toBe(null);
  });
});

describe("buildOrderedTocScenes", () => {
  it("marker 流：只列块里出现过的场次，按出现顺序", () => {
    const blocks = [{ ...makeMarkerBlock("scene_marker", { sceneId: "sc2" }) }, text("a"), { ...makeMarkerBlock("chapter_marker", { sceneId: "ch2" }) }];
    expect(buildOrderedTocScenes(scenes, blocks).map((s) => s.id)).toEqual(["sc2", "ch2"]);
  });
  it("旧版流：用过的按块序，没用过的按 scenes 表序插在相邻位置", () => {
    const blocks = [text("a", "sc2"), text("b", "ch1")];
    expect(buildOrderedTocScenes(scenes, blocks).map((s) => s.id)).toEqual(["sc1", "sc2", "ch1", "ch2"]);
  });
  it("没有任何块引用场次时为空", () => {
    expect(buildOrderedTocScenes(scenes, [text("a")])).toEqual([]);
  });
});

describe("syncSceneDetailsWithScenes / sameSceneRows", () => {
  it("按 scenes 表重排、缺的补空详情、场次字段以 scenes 为准；无变化返回原引用", () => {
    const details = [{ ...toSceneDetail(scenes[1]), synopsis: "s1" }];
    const next = syncSceneDetailsWithScenes(details, scenes.slice(0, 2));
    expect(next.map((d) => d.id)).toEqual(["ch1", "sc1"]);
    expect(next[1].synopsis).toBe("s1");
    const renamed = syncSceneDetailsWithScenes(next, [scenes[0], { ...scenes[1], name: "改名" }]);
    expect(renamed[1].name).toBe("改名");
    expect(renamed[1].synopsis).toBe("s1");
    expect(syncSceneDetailsWithScenes(next, scenes.slice(0, 2))).toBe(next);
  });
  it("sameSceneRows 逐字段比较", () => {
    expect(sameSceneRows(scenes, scenes.map((s) => ({ ...s })))).toBe(true);
    expect(sameSceneRows(scenes, [{ ...scenes[0], name: "x" }, ...scenes.slice(1)])).toBe(false);
  });
});

describe("computeLyricFromTags", () => {
  const groups = [{
    id: "g", name: "段", lyricSplitAfterOptionId: "o2",
    options: [{ id: "o1", sortOrder: 1 }, { id: "o2", sortOrder: 2 }, { id: "o3", sortOrder: 3 }],
  }] as unknown as TagGroup[];
  it("选项排在分界（含）之前为歌词，之后为非歌词；没有歌词组或块不带该组 → null", () => {
    expect(computeLyricFromTags([{ groupId: "g", optionId: "o1" }] as never, groups)).toBe(true);
    expect(computeLyricFromTags([{ groupId: "g", optionId: "o2" }] as never, groups)).toBe(true);
    expect(computeLyricFromTags([{ groupId: "g", optionId: "o3" }] as never, groups)).toBe(false);
    expect(computeLyricFromTags([{ groupId: "other", optionId: "x" }] as never, groups)).toBe(null);
    expect(computeLyricFromTags([{ groupId: "g", optionId: "o3" }] as never, [])).toBe(null);
  });
});
