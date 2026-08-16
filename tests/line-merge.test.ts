import { describe, it, expect } from "vitest";
import { mergeLines } from "@/lib/line-merge";

// wiki 协作行级三路合并：不相交改动都保留；重叠区间 mine（保存者）胜

const base = ["一", "二", "三", "四", "五"].join("\n");

describe("mergeLines", () => {
  it("trivial cases", () => {
    expect(mergeLines(base, base, base)).toBe(base);
    const mine = base.replace("二", "二改");
    expect(mergeLines(base, mine, base)).toBe(mine);
    expect(mergeLines(base, base, mine)).toBe(mine);
    expect(mergeLines(base, mine, mine)).toBe(mine);
  });

  it("non-overlapping edits from both sides are both kept", () => {
    const mine = ["一", "二改", "三", "四", "五"].join("\n");
    const theirs = ["一", "二", "三", "四", "五改"].join("\n");
    expect(mergeLines(base, mine, theirs)).toBe(["一", "二改", "三", "四", "五改"].join("\n"));
  });

  it("insertions at different anchors are both kept", () => {
    const mine = ["零", "一", "二", "三", "四", "五"].join("\n");
    const theirs = ["一", "二", "三", "四", "五", "六"].join("\n");
    expect(mergeLines(base, mine, theirs)).toBe(["零", "一", "二", "三", "四", "五", "六"].join("\n"));
  });

  it("overlapping edits: mine wins", () => {
    const mine = ["一", "二我", "三", "四", "五"].join("\n");
    const theirs = ["一", "二他", "三", "四", "五"].join("\n");
    expect(mergeLines(base, mine, theirs)).toBe(mine);
  });

  it("their deletion + my unrelated edit both apply", () => {
    const mine = ["一改", "二", "三", "四", "五"].join("\n");
    const theirs = ["一", "二", "四", "五"].join("\n"); // 删了 三
    expect(mergeLines(base, mine, theirs)).toBe(["一改", "二", "四", "五"].join("\n"));
  });

  it("same-anchor insertions conflict: mine wins", () => {
    const mine = ["一", "二", "插我", "三", "四", "五"].join("\n");
    const theirs = ["一", "二", "插他", "三", "四", "五"].join("\n");
    expect(mergeLines(base, mine, theirs)).toBe(mine);
  });
});
