import { describe, it, expect } from "vitest";
import { isPointCue, anchorEq, anchorSortKey } from "@/lib/ops/cue-anchor";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";

/**
 * cue 锚点的纯函数（#487 C1 从 CuePage.tsx 搬出）。锚有两种形状：块内偏移与块间
 * 缝隙；排序键要把「块 i 之后的缝隙」放在块 i 与块 i+1 之间，这是 cue 表按剧本顺序
 * 排列的基础。
 */
const blk = (blockId: string, offset: number): CueAnchor => ({ kind: "block", blockId, offset });
const gap = (afterBlockId: string | null): CueAnchor => ({ kind: "gap", afterBlockId });
const cue = (start: CueAnchor, end: CueAnchor): Cue =>
  ({ id: "r1", cueId: "c1", cueListId: "l1", number: "1", name: "", content: "", start, end, warning: false });

describe("anchorEq", () => {
  it("同形同值才相等；块锚比 blockId+offset，缝隙锚比 afterBlockId", () => {
    expect(anchorEq(blk("b1", 3), blk("b1", 3))).toBe(true);
    expect(anchorEq(blk("b1", 3), blk("b1", 4))).toBe(false);
    expect(anchorEq(blk("b1", 3), blk("b2", 3))).toBe(false);
    expect(anchorEq(gap("b1"), gap("b1"))).toBe(true);
    expect(anchorEq(gap(null), gap(null))).toBe(true);
    expect(anchorEq(gap("b1"), gap(null))).toBe(false);
  });
  it("跨形状永不相等", () => {
    expect(anchorEq(blk("b1", 0), gap("b1"))).toBe(false);
  });
});

describe("isPointCue", () => {
  it("起止同一锚是点 cue，否则是区间", () => {
    expect(isPointCue(cue(blk("b1", 2), blk("b1", 2)))).toBe(true);
    expect(isPointCue(cue(gap("b1"), gap("b1")))).toBe(true);
    expect(isPointCue(cue(blk("b1", 2), blk("b1", 5)))).toBe(false);
    expect(isPointCue(cue(blk("b1", 0), gap("b1")))).toBe(false);
  });
});

describe("anchorSortKey", () => {
  const index = new Map([["b0", 0], ["b1", 1], ["b2", 2]]);
  it("块 i 之后的缝隙排在块 i 全部偏移之后、块 i+1 之前", () => {
    const inB1Late = anchorSortKey(blk("b1", 999_990), index);
    const afterB1 = anchorSortKey(gap("b1"), index);
    const b2Start = anchorSortKey(blk("b2", 0), index);
    expect(inB1Late).toBeLessThan(afterB1);
    expect(afterB1).toBeLessThan(b2Start);
  });
  it("块内按 offset 递增；剧本最前的缝隙（afterBlockId=null）排在第一块之前", () => {
    expect(anchorSortKey(blk("b1", 0), index)).toBeLessThan(anchorSortKey(blk("b1", 1), index));
    expect(anchorSortKey(gap(null), index)).toBeLessThan(anchorSortKey(blk("b0", 0), index));
  });
  it("未知块按 -1 处理：落到最前面而不是抛错", () => {
    expect(anchorSortKey(blk("ghost", 5), index)).toBeLessThan(anchorSortKey(blk("b0", 0), index));
    expect(anchorSortKey(gap("ghost"), index)).toBe(anchorSortKey(gap(null), index));
  });
});
