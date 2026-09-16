// @vitest-environment jsdom
//
// #487 S5：ScriptEditor 角色聚焦簇出 hook。钉住：聚焦集合按剧本 id 存 localStorage 且换剧本即换集合；
// 勾中被聚合角色包含的成员 → 弹「连同聚合角色」提示，提示的三条出路（确认只加勾中的 / 全加 /
// 取消则不带聚合角色）；取消勾选成员时撤掉对应提示。提示只列「尚未聚焦」的聚合角色，所以
// 取消分支里的 delete 实际是保险丝，反证时去掉它不会红——钉的是结果集合不是那一行。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useCharacterFocus } from "@/components/script/script-editor/use-character-focus";
import { characterFocusStorageKey } from "@/components/script/script-editor/display-settings";
import type { Character } from "@/lib/script/script-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const characters: Character[] = [
  { id: "a", name: "甲", isAggregate: false },
  { id: "b", name: "乙", isAggregate: false },
  { id: "all", name: "众人", isAggregate: true, memberIds: ["a", "b"] },
  { id: "pair", name: "甲乙", isAggregate: true, memberIds: ["a", "b"] },
];
type Snapshot = ReturnType<typeof useCharacterFocus>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe({ scriptId }: { scriptId: string }) {
  seen.push(useCharacterFocus({ effectiveScriptId: scriptId, characters }));
  return null;
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seen.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(scriptId = "s1") { act(() => root.render(<Probe scriptId={scriptId} />)); }
const focused = () => [...latest().focusedCharacterIds].sort();
// key 里带本端 clientId（sessionStorage），跟着库函数取
const stored = (scriptId: string) => JSON.parse(localStorage.getItem(characterFocusStorageKey(scriptId)) ?? "[]").sort();

describe("useCharacterFocus — 持久化", () => {
  it("勾选写入 localStorage（按剧本 id），换剧本读另一份，清空即清", () => {
    localStorage.setItem(characterFocusStorageKey("s2"), JSON.stringify(["b"]));
    render("s1");
    expect(focused()).toEqual([]);
    act(() => latest().toggleCharacterFocus("all")); // 聚合角色本身：无提示
    expect(focused()).toEqual(["all"]);
    expect(stored("s1")).toEqual(["all"]);
    expect(latest().pendingAggregateFocusPrompt).toBe(null);
    render("s2");
    expect(focused()).toEqual(["b"]);
    act(() => latest().clearCharacterFocus());
    expect(focused()).toEqual([]);
    expect(stored("s2")).toEqual([]);
  });
});

describe("useCharacterFocus — 聚合提示", () => {
  it("勾中成员 → 提示列出包含它且尚未聚焦的聚合角色；确认只加勾中的", () => {
    render();
    act(() => latest().toggleCharacterFocus("pair"));
    act(() => latest().toggleCharacterFocus("a"));
    expect(focused()).toEqual(["a", "pair"]);
    expect(latest().pendingAggregateFocusPrompt).toEqual({ characterId: "a", aggregateIds: ["all"], selectedIds: new Set() });
    act(() => latest().togglePendingAggregateFocus("all"));
    act(() => latest().confirmAggregateFocusPrompt());
    expect(focused()).toEqual(["a", "all", "pair"]);
    expect(latest().pendingAggregateFocusPrompt).toBe(null);
  });

  it("全加 / 取消：取消把提示里的聚合角色从集合剔掉；取消勾选成员撤掉它的提示", () => {
    render();
    act(() => latest().toggleCharacterFocus("a"));
    expect(latest().pendingAggregateFocusPrompt?.aggregateIds).toEqual(["all", "pair"]);
    act(() => latest().addAllAggregateFocusPrompt());
    expect(focused()).toEqual(["a", "all", "pair"]);

    act(() => latest().toggleCharacterFocus("b")); // all/pair 已聚焦 → 无提示
    expect(latest().pendingAggregateFocusPrompt).toBe(null);
    act(() => latest().clearCharacterFocus());

    act(() => latest().toggleCharacterFocus("a"));
    act(() => latest().cancelAggregateFocusPrompt());
    expect(focused()).toEqual(["a"]);
    expect(stored("s1")).toEqual(["a"]);

    act(() => latest().toggleCharacterFocus("b"));
    expect(latest().pendingAggregateFocusPrompt?.characterId).toBe("b");
    act(() => latest().toggleCharacterFocus("b")); // 取消勾选 b
    expect(latest().pendingAggregateFocusPrompt).toBe(null);
    expect(focused()).toEqual(["a"]);
  });
});
