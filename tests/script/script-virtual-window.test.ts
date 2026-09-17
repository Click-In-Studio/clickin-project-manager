import { describe, it, expect } from "vitest";
import {
  clampWindowRange, buildCumulativeHeights, blockAtOffset, spacerHeightsFor,
  resolveActiveSceneIdForBlockIndex, nextWindowRange,
} from "@/lib/script/script-virtual-window";
import type { Block } from "@/lib/script/script-types";

/**
 * 剧本编辑器虚拟窗口的纯算术（#487 S6 从 ScriptEditor 回调里抽出）。窗口 / 垫片 / 当前场
 * 一旦算错，表现是滚动跳变或目录高亮错场，肉眼极难归因。
 */
describe("clampWindowRange", () => {
  it("夹进 [0, n] 且至少一块；空剧本 [0,0)", () => {
    expect(clampWindowRange({ start: -5, end: 3 }, 10)).toEqual({ start: 0, end: 3 });
    expect(clampWindowRange({ start: 8, end: 99 }, 10)).toEqual({ start: 8, end: 10 });
    expect(clampWindowRange({ start: 12, end: 12 }, 10)).toEqual({ start: 9, end: 10 });
    expect(clampWindowRange({ start: 4, end: 2 }, 10)).toEqual({ start: 4, end: 5 });
    expect(clampWindowRange({ start: 0, end: 5 }, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("buildCumulativeHeights / blockAtOffset / spacerHeightsFor", () => {
  const blocks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("没量过的块用已量块的平均值，一块都没量过用 defaultH；隐藏块计 0", () => {
    expect(buildCumulativeHeights(blocks, new Map(), 0, null, 80)).toEqual([0, 80, 160, 240, 320]);
    const measured = new Map([["a", 100], ["c", 40]]); // avg 70
    expect(buildCumulativeHeights(blocks, measured, 140, null, 80)).toEqual([0, 100, 170, 210, 280]);
    expect(buildCumulativeHeights(blocks, measured, 140, "b", 80)).toEqual([0, 100, 100, 140, 210]);
  });

  it("blockAtOffset：顶边落在 offset 之后的第一块；越界取尾块；空表为 0", () => {
    const cum = [0, 100, 170, 210, 280];
    expect(blockAtOffset(cum, 0)).toBe(0);
    expect(blockAtOffset(cum, 99)).toBe(0);
    expect(blockAtOffset(cum, 100)).toBe(1);
    expect(blockAtOffset(cum, 209)).toBe(2);
    expect(blockAtOffset(cum, 10_000)).toBe(3);
    expect(blockAtOffset([0], 50)).toBe(0);
  });

  it("spacerHeightsFor：按累计表算两端垫片；表不够长时按 defaultH 估", () => {
    const cum = [0, 100, 170, 210, 280];
    expect(spacerHeightsFor(cum, { start: 1, end: 3 }, 4, 80)).toEqual({ top: 100, bot: 70 });
    expect(spacerHeightsFor(cum, { start: 0, end: 4 }, 4, 80)).toEqual({ top: 0, bot: 0 });
    expect(spacerHeightsFor([0], { start: 2, end: 5 }, 10, 80)).toEqual({ top: 160, bot: 400 });
  });
});

describe("resolveActiveSceneIdForBlockIndex", () => {
  const b = (id: string, type: string, sceneId: string | null) => ({ id, type, sceneId, content: "", characterIds: [] } as unknown as Block);
  const blocks = [
    b("m1", "scene_marker", "s1"), b("t1", "dialogue", null), b("t2", "dialogue", "ghost"),
    b("m2", "scene_marker", "s2"), b("t3", "dialogue", null),
  ];
  const owned = [{ sceneId: "s1" }, { sceneId: "s1" }, { sceneId: null }, { sceneId: "s2" }, { sceneId: "s2" }];
  const sceneIds = new Set(["s1", "s2"]);

  it("标记块自带；正文块先看归属投影再看自己的；不存在的场不算", () => {
    expect(resolveActiveSceneIdForBlockIndex(blocks, owned, sceneIds, 0, 5)).toBe("s1");
    expect(resolveActiveSceneIdForBlockIndex(blocks, owned, sceneIds, 1, 5)).toBe("s1");
    expect(resolveActiveSceneIdForBlockIndex(blocks, owned, sceneIds, 4, 5)).toBe("s2");
    // t2：投影无、自己的 ghost 不存在 → 往前找到 t1 的 s1
    expect(resolveActiveSceneIdForBlockIndex(blocks, owned, sceneIds, 2, 5)).toBe("s1");
  });

  it("就近搜索只在 buffer 内；索引越界夹到两端；没有场或没有块为 null", () => {
    const far = [b("x", "dialogue", null), b("y", "dialogue", null), b("m", "scene_marker", "s1")];
    const none = [{ sceneId: null }, { sceneId: null }, { sceneId: null }];
    expect(resolveActiveSceneIdForBlockIndex(far, none, sceneIds, 0, 1)).toBe(null);
    expect(resolveActiveSceneIdForBlockIndex(far, none, sceneIds, 0, 2)).toBe("s1");
    expect(resolveActiveSceneIdForBlockIndex(blocks, owned, sceneIds, 99, 5)).toBe("s2");
    expect(resolveActiveSceneIdForBlockIndex(blocks, owned, new Set(), 0, 5)).toBe(null);
    expect(resolveActiveSceneIdForBlockIndex([], [], sceneIds, 0, 5)).toBe(null);
  });
});

describe("nextWindowRange", () => {
  it("两端余量都 ≥ max(40, buffer/3) 时不动；否则前后各留 buffer 并夹进 [0, n]", () => {
    expect(nextWindowRange({ start: 100, end: 400 }, 150, 350, 1000, 120, [])).toBe(null);
    expect(nextWindowRange({ start: 100, end: 400 }, 130, 350, 1000, 120, [])).toEqual({ start: 10, end: 471 });
    expect(nextWindowRange({ start: 0, end: 240 }, 5, 30, 1000, 120, [])).toEqual({ start: 0, end: 151 });
    expect(nextWindowRange({ start: 800, end: 1000 }, 900, 995, 1000, 120, [])).toEqual({ start: 780, end: 1000 });
  });

  it("焦点块 / 待聚焦块硬包进窗口；-1 表示没有", () => {
    expect(nextWindowRange({ start: 0, end: 240 }, 5, 30, 1000, 120, [-1, 600])).toEqual({ start: 0, end: 601 });
    expect(nextWindowRange({ start: 500, end: 800 }, 510, 700, 1000, 120, [3, -1])).toEqual({ start: 3, end: 821 });
  });
});
