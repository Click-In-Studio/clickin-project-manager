// @vitest-environment jsdom
//
// #487 S4：ScriptEditor 搜索 / 跳转簇出 hook。钉住：命中只算正文块、大小写与「精确」开关、
// 「仅当前页」按焦点块所在页过滤、游标变化即滚到命中块、从外壳搜索带 query 进来要等加载完才展开、
// 跳行按正文行计数（跳过标记块）、跳页找页首块。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScriptSearch } from "@/components/script/script-editor/use-script-search";
import type { Block } from "@/lib/script/script-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const blocks = [
  { id: "m0", type: "scene_marker", content: "第一场", characterIds: [] },
  { id: "b1", type: "dialogue", content: "<b>Hamlet</b> 到底要不要", characterIds: [] },
  { id: "b2", type: "stage", content: "hamlet 走过舞台", characterIds: [] },
  { id: "m1", type: "scene_marker", content: "第二场", characterIds: [] },
  { id: "b3", type: "dialogue", content: "无关的一句", characterIds: [] },
  { id: "b4", type: "dialogue", content: "HAMLET！", characterIds: [] },
] as unknown as Block[];
const pageMap: Record<string, number> = { m0: 1, b1: 1, b2: 1, m1: 2, b3: 2, b4: 2 };

type Snapshot = ReturnType<typeof useScriptSearch>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
const scrollToBlockIdx = vi.fn();
function Probe({ focusedId, loadState, initialSearchQuery }: { focusedId: string | null; loadState: string; initialSearchQuery?: string }) {
  seen.push(useScriptSearch({ blocks, pageMap, focusedId, loadState, initialSearchQuery, scrollToBlockIdx }));
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seen.length = 0;
  scrollToBlockIdx.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(p: { focusedId?: string | null; loadState?: string; initialSearchQuery?: string } = {}) {
  act(() => root.render(<Probe focusedId={p.focusedId ?? null} loadState={p.loadState ?? "ready"} initialSearchQuery={p.initialSearchQuery} />));
}
function search(q: string) {
  act(() => { latest().setSearchOpen(true); latest().setSearchQuery(q); latest().setSearchIdx(0); });
}

describe("useScriptSearch — 命中", () => {
  it("关着不算；开了按正文块、去 HTML、忽略大小写匹配；精确开关区分大小写", () => {
    render();
    act(() => latest().setSearchQuery("hamlet"));
    expect(latest().searchMatches).toEqual([]);
    search("hamlet");
    expect(latest().searchMatches).toEqual([1, 2, 5]);
    act(() => latest().setSearchExact(true));
    expect(latest().searchMatches).toEqual([2]);
  });

  it("「仅当前页」按焦点块所在页过滤；无焦点时不过滤", () => {
    render({ focusedId: "b3" });
    search("hamlet");
    act(() => latest().setSearchCurrentPage(true));
    expect(latest().searchMatches).toEqual([5]);
    render({ focusedId: null });
    expect(latest().searchMatches).toEqual([1, 2, 5]);
  });

  it("游标指到哪条就滚到哪块；无命中不滚", () => {
    render();
    search("hamlet");
    expect(scrollToBlockIdx).toHaveBeenLastCalledWith(1, "center");
    act(() => latest().setSearchIdx(2));
    expect(scrollToBlockIdx).toHaveBeenLastCalledWith(5, "center");
    scrollToBlockIdx.mockClear();
    search("不存在");
    expect(scrollToBlockIdx).not.toHaveBeenCalled();
  });
});

describe("useScriptSearch — 外壳带 query 进来", () => {
  it("加载完才展开搜索并填入 query，只消费一次", () => {
    render({ loadState: "loading", initialSearchQuery: "hamlet" });
    expect(latest().searchOpen).toBe(false);
    render({ loadState: "ready", initialSearchQuery: "hamlet" });
    expect(latest().searchOpen).toBe(true);
    expect(latest().searchQuery).toBe("hamlet");
    expect(latest().searchMatches).toEqual([1, 2, 5]);
    act(() => { latest().setSearchOpen(false); });
    render({ loadState: "loading", initialSearchQuery: "hamlet" });
    render({ loadState: "ready", initialSearchQuery: "hamlet" });
    expect(latest().searchOpen).toBe(false);
  });
});

describe("useScriptSearch — 跳转", () => {
  it("jumpToLine 只数正文块（跳过标记），越界不动；jumpToPage 找页首块", () => {
    render();
    act(() => latest().jumpToLine(3)); // 正文第 3 行 = b3（索引 4）
    expect(scrollToBlockIdx).toHaveBeenLastCalledWith(4, "center");
    act(() => latest().jumpToLine(0)); // 夹到第 1 行
    expect(scrollToBlockIdx).toHaveBeenLastCalledWith(1, "center");
    scrollToBlockIdx.mockClear();
    act(() => latest().jumpToLine(99));
    expect(scrollToBlockIdx).not.toHaveBeenCalled();
    act(() => latest().jumpToPage(2)); // 页首块是标记 m1（索引 3）
    expect(scrollToBlockIdx).toHaveBeenLastCalledWith(3, "start");
  });
});
