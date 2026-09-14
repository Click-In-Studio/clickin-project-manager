import { describe, it, expect } from "vitest";
import { sameDragTarget, resolveDragTarget, getDragInsertIndex } from "@/lib/script/script-drag-target";
import { makeBlock } from "@/lib/script/script-block-stream";

/** 块拖拽落点解析（#487 S1 从 ScriptEditor.tsx 搬出）：边缘落点按虚拟窗口折算成块落点。 */
const blocks = ["a", "b", "c", "d"].map((id) => ({ ...makeBlock(), id }));

describe("sameDragTarget", () => {
  it("同引用 / 同值相等，null 与跨种类不等", () => {
    expect(sameDragTarget(null, null)).toBe(true);
    expect(sameDragTarget({ kind: "edge", edge: "top" }, { kind: "edge", edge: "top" })).toBe(true);
    expect(sameDragTarget({ kind: "block", id: "a", position: "before" }, { kind: "block", id: "a", position: "after" })).toBe(false);
    expect(sameDragTarget({ kind: "edge", edge: "top" }, { kind: "block", id: "a", position: "before" })).toBe(false);
    expect(sameDragTarget(null, { kind: "edge", edge: "top" })).toBe(false);
  });
});

describe("resolveDragTarget", () => {
  it("块落点原样返回；顶边 → 窗口首块之前，底边 → 窗口末块之后", () => {
    const win = { start: 1, end: 3 };
    expect(resolveDragTarget({ kind: "block", id: "c", position: "after" }, blocks, win)).toEqual({ kind: "block", id: "c", position: "after" });
    expect(resolveDragTarget({ kind: "edge", edge: "top" }, blocks, win)).toEqual({ kind: "block", id: "b", position: "before" });
    expect(resolveDragTarget({ kind: "edge", edge: "bottom" }, blocks, win)).toEqual({ kind: "block", id: "c", position: "after" });
  });
  it("窗口越界被夹到块数组边界；空数组为 null", () => {
    expect(resolveDragTarget({ kind: "edge", edge: "bottom" }, blocks, { start: 0, end: 99 })).toEqual({ kind: "block", id: "d", position: "after" });
    expect(resolveDragTarget({ kind: "edge", edge: "top" }, blocks, { start: 99, end: 99 })).toEqual({ kind: "block", id: "d", position: "before" });
    expect(resolveDragTarget({ kind: "edge", edge: "top" }, [], { start: 0, end: 0 })).toBe(null);
  });
});

describe("getDragInsertIndex", () => {
  it("before = 该块下标，after = 下标 + 1，找不到为 -1", () => {
    expect(getDragInsertIndex({ kind: "block", id: "b", position: "before" }, blocks)).toBe(1);
    expect(getDragInsertIndex({ kind: "block", id: "b", position: "after" }, blocks)).toBe(2);
    expect(getDragInsertIndex({ kind: "block", id: "zz", position: "after" }, blocks)).toBe(-1);
  });
});
