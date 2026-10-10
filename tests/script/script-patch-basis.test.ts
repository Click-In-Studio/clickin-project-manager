import { describe, expect, it } from "vitest";
import { buildScriptPatchBasis, conditionScriptPatch, ScriptPatchConflict } from "@/lib/script/script-patch-basis";
import { diffState, type ScriptPatch } from "@/lib/script/script-ops";
import { DEFAULT_SCRIPT_CONFIG, type Block, type ScriptState } from "@/lib/script/script-types";
const block = (id: string, content = id): Block => ({ id, type: "stage", content, sceneId: null, rehearsalMark: null, lyric: false, characterIds: [], characterAnnotations: {} });
const base: ScriptState = { blocks: [block("a"), block("b")], characters: [{ id: "c", name: "甲", isAggregate: false }], scenes: [{ id: "s", name: "第一场", number: "1", parentId: null }], config: DEFAULT_SCRIPT_CONFIG };
const empty = (): ScriptPatch => ({ clientSeq: 1, blockOps: [], charOps: [], sceneOps: [] });
function check(patch: ScriptPatch, current = base) {
 return conditionScriptPatch(patch, buildScriptPatchBasis(base, patch, new Map()), current, new Map(), current.blocks.map(b => b.id));
}
describe("条件保存的操作边界", () => {
 it("整块更新保护批注、角色关联和标记信息，不能只比较正文", () => {
  const p = diffState(base, { ...base, blocks: [{ ...base.blocks[0], content: "本地" }, base.blocks[1]] }, 1);
  for (const changed of [{ stageComment: "线上批注" }, { characterIds: ["c"] }, { markerMeta: { synopsis: "线上简介" } }]) {
   expect(() => check(p, { ...base, blocks: [{ ...base.blocks[0], ...changed }, base.blocks[1]] })).toThrow(ScriptPatchConflict);
  }
 });
 it("目标已达到时不重复插入、删除、排序或创建角色", () => {
  const p: ScriptPatch = { ...empty(), blockOps: [{ op: "insert", block: block("x"), afterId: "b" }, { op: "delete", id: "a" }, { op: "reorder", ids: ["b", "x"] }], charOps: [{ op: "upsert", char: { id: "new", name: "乙", isAggregate: false } }] };
  const current = { ...base, blocks: [block("b"), block("x")], characters: [...base.characters, { id: "new", name: "乙", isAggregate: false }] };
  expect(check(p, current)).toEqual(empty());
 });
 it("角色改名或删除不能盖掉远端新元数据", () => {
  const current = { ...base, characters: [{ ...base.characters[0], name: "导演改名" }] };
  for (const op of [{ op: "upsert", char: { ...base.characters[0], name: "本地改名" } }, { op: "delete", id: "c" }] as ScriptPatch["charOps"]) {
   expect(() => check({ ...empty(), charOps: [op] }, current)).toThrow(ScriptPatchConflict);
  }
 });
 it("场次改名、删除和排序都检查原依据", () => {
  const current = { ...base, scenes: [{ ...base.scenes[0], name: "导演改场名" }] };
  for (const op of [{ op: "upsert", scene: { ...base.scenes[0], name: "本地改场名" } }, { op: "delete", id: "s" }] as ScriptPatch["sceneOps"]) {
   expect(() => check({ ...empty(), sceneOps: [op] }, current)).toThrow(ScriptPatchConflict);
  }
  const extended = { ...base, scenes: [...base.scenes, { id: "s2", name: "新场", number: "2", parentId: null }] };
  expect(() => check({ ...empty(), sceneOps: [{ op: "reorder", ids: ["s"] }] }, extended)).toThrow(ScriptPatchConflict);
 });
 it("标签单独比较旧值；不能因正文没变就忽略标签冲突", () => {
  const p: ScriptPatch = { ...empty(), blockOps: [{ op: "update", block: base.blocks[0], tags: [{ groupId: "g", optionId: null, value: 2 }] }] };
  const basis = buildScriptPatchBasis(base, p, new Map([["a", [{ groupId: "g", optionId: null, value: 1 }]]]));
  const tags = new Map([["a", [{ groupId: "g", optionId: null, value: 3 }]]]);
  expect(() => conditionScriptPatch(p, basis, base, tags, ["a", "b"])).toThrow(ScriptPatchConflict);
 });
 it("标签已达到目标时不重复写；正文冲突仍不能被标签成功旁路", () => {
  const p: ScriptPatch = { ...empty(), blockOps: [{ op: "update", block: base.blocks[0], tags: [{ groupId: "g", optionId: null, value: 2 }] }] };
  const basis = buildScriptPatchBasis(base, p, new Map());
  const tags = new Map([["a", p.blockOps[0].op === "update" ? p.blockOps[0].tags! : []]]);
  expect(conditionScriptPatch(p, basis, base, tags, ["a", "b"]).blockOps).toEqual([]);
  expect(() => conditionScriptPatch(p, basis, { ...base, blocks: [block("a", "远端"), block("b")] }, tags, ["a", "b"])).toThrow(ScriptPatchConflict);
 });
});
