import { describe, expect, it } from "vitest";
import { nextIdlePrefetchRange } from "@/lib/script/script-window-prefetch";

function missingExcept(loaded: Array<[number, number]>, markers: number[] = []) {
  const loadedIndexes = new Set<number>();
  for (const [start, end] of loaded) {
    for (let index = start; index < end; index++) loadedIndexes.add(index);
  }
  const markerIndexes = new Set(markers);
  return (index: number) => !loadedIndexes.has(index) && !markerIndexes.has(index);
}

describe("剧本空闲补窗调度（#641）", () => {
  it("从当前视窗向阅读方向取最近一窗", () => {
    expect(nextIdlePrefetchRange(2_000, { start: 800, end: 1_040 }, missingExcept([[800, 1_040]])))
      .toEqual({ start: 1_040, limit: 480 });
  });

  it("后方已暖好后转向前方，不重复已加载窗口", () => {
    expect(nextIdlePrefetchRange(2_000, { start: 800, end: 1_040 }, missingExcept([[800, 1_520]])))
      .toEqual({ start: 320, limit: 480 });
  });

  it("跳过无需正文的 marker，并在整本到齐后停止", () => {
    expect(nextIdlePrefetchRange(8, { start: 2, end: 6 }, missingExcept([[0, 6]], [6])))
      .toEqual({ start: 7, limit: 1 });
    expect(nextIdlePrefetchRange(8, { start: 2, end: 6 }, missingExcept([[0, 8]])))
      .toBeNull();
  });
});
