import assert from "node:assert/strict";
import {
  convertMarker, executeMarkerDeletion, insertMarker, normalizeMarkerState, planMarkerDeletion, projectMarkers, resolveMarkerId, updateMarkerMeta,
} from "../lib/script-marker-domain";
import { DEFAULT_SCRIPT_CONFIG, type Block, type ScriptState } from "../lib/script-types";
import { patchAffectsMarkerProjection, type ScriptPatch } from "../lib/script-ops";

let id = 0;
const createId = () => `generated-${++id}`;

function block(id: string, type: Block["type"], content = "", legacySceneId: string | null = id): Block {
  return {
    id, type, content, characterIds: [], characterAnnotations: {}, lyric: false,
    sceneId: type === "chapter_marker" || type === "scene_marker" ? legacySceneId : null,
    rehearsalMark: null, forceShowCharacterName: false,
  };
}

function state(blocks: Block[]): ScriptState {
  return { blocks, scenes: [], characters: [], config: { ...DEFAULT_SCRIPT_CONFIG, openingChapterMarkerId: "c0" } };
}

function markerIds(value: ScriptState): string[] {
  return value.blocks.filter((item) => item.type === "chapter_marker" || item.type === "scene_marker").map((item) => item.id);
}

const patch = (blockOps: ScriptPatch["blockOps"]): ScriptPatch =>
  ({ clientSeq: 0, blockOps, charOps: [], sceneOps: [] });

const baseline = state([
  block("c0", "chapter_marker", "", "legacy-c0"),
  block("s01", "scene_marker", "", "legacy-s01"),
  block("t01", "dialogue", "opening text", null),
  block("c1", "chapter_marker", "", "legacy-c1"),
  block("s11", "scene_marker", "", "legacy-s11"),
  block("t11", "dialogue", "chapter one", null),
  block("c2", "chapter_marker", "", "legacy-c2"),
  block("s21", "scene_marker", "", "legacy-s21"),
  block("t21", "dialogue", "chapter two", null),
]);

assert.equal(resolveMarkerId(baseline, "legacy-s11"), "s11");
assert.deepEqual(projectMarkers(baseline).map(({ id, kind, parentId }) => ({ id, kind, parentId })), [
  { id: "c0", kind: "chapter", parentId: null },
  { id: "s01", kind: "scene", parentId: "c0" },
  { id: "c1", kind: "chapter", parentId: null },
  { id: "s11", kind: "scene", parentId: "c1" },
  { id: "c2", kind: "chapter", parentId: null },
  { id: "s21", kind: "scene", parentId: "c2" },
]);

const forcedFirstScene = normalizeMarkerState(state([
  block("c0", "chapter_marker"),
  block("empty-before-scenes", "dialogue", "", null),
  block("s01", "scene_marker"),
  block("t01", "dialogue", "one", null),
  block("s02", "scene_marker"),
  block("t02", "dialogue", "two", null),
]), createId);
assert.equal(forcedFirstScene.blocks[1]?.type, "scene_marker");
assert.equal(forcedFirstScene.blocks.filter((item) => item.type === "scene_marker").length, 3);

const forcedFirstScenesAcrossChapters = normalizeMarkerState(state([
  block("c0", "chapter_marker"), block("empty-0", "dialogue", "", null), block("s01", "scene_marker"),
  block("c1", "chapter_marker"), block("empty-1", "dialogue", "", null), block("s11", "scene_marker"),
]), createId);
assert.equal(forcedFirstScenesAcrossChapters.blocks[1]?.type, "scene_marker");
const secondChapterIndex = forcedFirstScenesAcrossChapters.blocks.findIndex((item) => item.id === "c1");
assert.equal(forcedFirstScenesAcrossChapters.blocks[secondChapterIndex + 1]?.type, "scene_marker");

const middleChapterToScene = convertMarker(baseline, "legacy-c1", "scene", createId);
assert.deepEqual(markerIds(middleChapterToScene).filter((markerId) => baseline.blocks.some((item) => item.id === markerId)), markerIds(baseline));
assert.equal(middleChapterToScene.blocks.find((item) => item.id === "c1")?.type, "scene_marker");

const firstChapterToScene = convertMarker(baseline, "legacy-c0", "scene", createId);
const convertedFirstIndex = firstChapterToScene.blocks.findIndex((item) => item.id === "c0");
assert.equal(firstChapterToScene.blocks[convertedFirstIndex - 1]?.type, "chapter_marker");
assert.equal(firstChapterToScene.blocks[convertedFirstIndex]?.type, "scene_marker");

const firstSceneToChapter = convertMarker(baseline, "legacy-s01", "chapter", createId);
assert.deepEqual(markerIds(firstSceneToChapter), markerIds(baseline));
assert.equal(firstSceneToChapter.blocks.find((item) => item.id === "s01")?.type, "chapter_marker");

const repeated = convertMarker(convertMarker(middleChapterToScene, "c1", "chapter", createId), "c1", "scene", createId);
assert.equal(repeated.blocks.find((item) => item.id === "c1")?.type, "scene_marker");

const insertedAtTextBoundary = insertMarker(
  baseline,
  { kind: "scene", parentId: "c1", beforeBlockId: "t11", name: "inserted" },
  createId,
);
const insertedProjection = projectMarkers(insertedAtTextBoundary);
const insertedScene = insertedProjection.find((item) => item.name === "inserted");
assert.ok(insertedScene);
assert.equal(insertedScene.parentId, "c1");
assert.ok(insertedAtTextBoundary.blocks.findIndex((item) => item.id === insertedScene.id) < insertedAtTextBoundary.blocks.findIndex((item) => item.id === "t11"));

const chapterAfterOwnedRange = insertMarker(
  baseline,
  { kind: "chapter", afterId: "c1", name: "after chapter one" },
  createId,
);
const chapterAfterOwnedRangeId = projectMarkers(chapterAfterOwnedRange).find((item) => item.name === "after chapter one")?.id;
assert.ok(chapterAfterOwnedRangeId);
assert.ok(chapterAfterOwnedRange.blocks.findIndex((item) => item.id === chapterAfterOwnedRangeId) > chapterAfterOwnedRange.blocks.findIndex((item) => item.id === "t11"));
assert.deepEqual(markerIds(chapterAfterOwnedRange).slice(0, 5), ["c0", "s01", "c1", "s11", chapterAfterOwnedRangeId]);
const deleteAddedChapterPlan = planMarkerDeletion(chapterAfterOwnedRange, chapterAfterOwnedRangeId);
assert.equal(deleteAddedChapterPlan.status, "ready");
const withoutAddedChapter = deleteAddedChapterPlan.status === "ready"
  ? executeMarkerDeletion(chapterAfterOwnedRange, deleteAddedChapterPlan.operation, createId)
  : chapterAfterOwnedRange;
assert.equal(projectMarkers(withoutAddedChapter).some((item) => item.id === chapterAfterOwnedRangeId), false);
assert.deepEqual(markerIds(withoutAddedChapter), markerIds(baseline));

let repeatedChapterAdds = baseline;
const repeatedChapterIds: string[] = [];
for (const name of ["added one", "added two", "added three"]) {
  repeatedChapterAdds = insertMarker(repeatedChapterAdds, { kind: "chapter", afterId: "c1", name }, createId);
  repeatedChapterIds.push(projectMarkers(repeatedChapterAdds).find((item) => item.name === name)!.id);
}
const repeatedDeletePlan = planMarkerDeletion(repeatedChapterAdds, repeatedChapterIds[1]);
assert.equal(repeatedDeletePlan.status, "ready");
const afterRepeatedDelete = repeatedDeletePlan.status === "ready"
  ? executeMarkerDeletion(repeatedChapterAdds, repeatedDeletePlan.operation, createId)
  : repeatedChapterAdds;
assert.equal(projectMarkers(afterRepeatedDelete).some((item) => item.id === repeatedChapterIds[1]), false);
assert.deepEqual(
  markerIds(afterRepeatedDelete).filter((markerId) => !repeatedChapterIds.includes(markerId)),
  markerIds(baseline),
);
assert.equal(afterRepeatedDelete.blocks.filter((item) => item.type === "scene_marker").length, baseline.blocks.filter((item) => item.type === "scene_marker").length);

const chapterBeforeScene = insertMarker(baseline, { kind: "chapter", beforeId: "s11", name: "before 1-1" }, createId);
const chapterBeforeSceneId = projectMarkers(chapterBeforeScene).find((item) => item.name === "before 1-1")?.id;
assert.ok(chapterBeforeSceneId);
assert.equal(
  chapterBeforeScene.blocks.findIndex((item) => item.id === chapterBeforeSceneId) + 1,
  chapterBeforeScene.blocks.findIndex((item) => item.id === "s11"),
);
const deleteChapterBeforeScenePlan = planMarkerDeletion(chapterBeforeScene, chapterBeforeSceneId);
assert.equal(deleteChapterBeforeScenePlan.status, "ready");
const afterDeleteChapterBeforeScene = deleteChapterBeforeScenePlan.status === "ready"
  ? executeMarkerDeletion(chapterBeforeScene, deleteChapterBeforeScenePlan.operation, createId)
  : chapterBeforeScene;
assert.equal(projectMarkers(afterDeleteChapterBeforeScene).some((item) => item.id === chapterBeforeSceneId), false);
assert.equal(
  afterDeleteChapterBeforeScene.blocks.filter((item) => item.type === "scene_marker").length,
  baseline.blocks.filter((item) => item.type === "scene_marker").length,
);
const sceneAtChapterEnd = insertMarker(baseline, { kind: "scene", parentId: "c1", beforeId: "c2", name: "end of chapter one" }, createId);
const sceneAtChapterEndId = projectMarkers(sceneAtChapterEnd).find((item) => item.name === "end of chapter one")?.id;
assert.ok(sceneAtChapterEndId);
assert.equal(projectMarkers(sceneAtChapterEnd).find((item) => item.id === sceneAtChapterEndId)?.parentId, "c1");
assert.equal(
  sceneAtChapterEnd.blocks.findIndex((item) => item.id === sceneAtChapterEndId) + 2,
  sceneAtChapterEnd.blocks.findIndex((item) => item.id === "c2"),
);

const addedOpening = insertMarker(baseline, { kind: "chapter", name: "", beforeId: "c0" }, createId);
const addedOpeningMarker = projectMarkers(addedOpening)[0];
const addedOpeningIndex = addedOpening.blocks.findIndex((item) => item.id === addedOpeningMarker.id);
assert.equal(addedOpeningMarker.name, "开场");
assert.equal(addedOpening.blocks[addedOpeningIndex + 1]?.type, "dialogue");
assert.equal(addedOpening.blocks[addedOpeningIndex + 1]?.content, "");

const detailBlocked = state([
  { ...block("c0", "chapter_marker"), markerMeta: { synopsis: "detail" } },
  block("empty", "dialogue", "", null),
]);
assert.equal(planMarkerDeletion(detailBlocked, "c0").status, "blocked");

const nonEmptyMarkerOnly = planMarkerDeletion(baseline, "legacy-s11");
assert.deepEqual(nonEmptyMarkerOnly.status === "ready" ? nonEmptyMarkerOnly.operation : null, { type: "marker-only", markerId: "s11" });
const retained = executeMarkerDeletion(baseline, { type: "marker-only", markerId: "legacy-s11" }, createId);
assert.ok(retained.blocks.some((item) => item.id === "t11"));
assert.ok(!retained.blocks.some((item) => item.id === "s11"));

const emptyScene = state([
  block("c0", "chapter_marker"), block("s0", "scene_marker"), block("empty", "dialogue", "", null),
]);
const emptyPlan = planMarkerDeletion(emptyScene, "s0");
assert.equal(emptyPlan.status, "ready");
assert.equal(emptyPlan.status === "ready" ? emptyPlan.operation.type : null, "whole");

const emptyChapter = state([block("c0", "chapter_marker"), block("empty", "dialogue", "", null)]);
const emptyChapterPlan = planMarkerDeletion(emptyChapter, "c0");
assert.equal(emptyChapterPlan.status, "ready");
assert.equal(emptyChapterPlan.status === "ready" ? emptyChapterPlan.operation.type : null, "whole");

const emptyChapterWithScenes = state([
  block("c0", "chapter_marker"),
  block("s01", "scene_marker"), block("empty-1", "dialogue", "", null),
  block("s02", "scene_marker"), block("empty-2", "dialogue", "", null),
]);
const choicePlan = planMarkerDeletion(emptyChapterWithScenes, "c0");
assert.equal(choicePlan.status, "choice");
assert.deepEqual(choicePlan.status === "choice" ? choicePlan.options.map((option) => option.type) : [], ["marker-only", "whole"]);

const mixedChapter = state([
  block("c0", "chapter_marker"),
  block("s01", "scene_marker"), block("empty-1", "dialogue", "", null),
  block("s02", "scene_marker"), block("text-2", "dialogue", "not empty", null),
]);
const mixedPlan = planMarkerDeletion(mixedChapter, "c0");
assert.equal(mixedPlan.status, "ready");
assert.equal(mixedPlan.status === "ready" ? mixedPlan.operation.type : null, "marker-only");

const legacyDetailPlan = planMarkerDeletion(
  emptyScene,
  "s0",
  [{ id: "s0", number: "", name: "", parentId: "c0", synopsis: "legacy detail" }],
);
assert.equal(legacyDetailPlan.status, "blocked");

const reparentSource = state([
  block("c0", "chapter_marker"), block("s01", "scene_marker"), block("text-1", "dialogue", "keep", null),
  block("c1", "chapter_marker"), block("s11", "scene_marker"), block("text-2", "dialogue", "keep too", null),
]);
const reparented = executeMarkerDeletion(reparentSource, { type: "marker-only", markerId: "c1" }, createId);
assert.ok(reparented.blocks.some((item) => item.id === "text-2"));
assert.equal(projectMarkers(reparented).find((item) => item.id === "s11")?.parentId, "c0");

const chapterDuration = updateMarkerMeta(baseline, "c1", { expectedDuration: "120" });
assert.equal(chapterDuration.blocks.find((item) => item.id === "c1")?.markerMeta?.expectedDuration, undefined);
const emptyChapterDuration = updateMarkerMeta(emptyChapter, "c0", { expectedDuration: "120" });
assert.equal(emptyChapterDuration.blocks.find((item) => item.id === "c0")?.markerMeta?.expectedDuration, "120");
const sceneDuration = updateMarkerMeta(baseline, "s11", { expectedDuration: "120" });
assert.equal(sceneDuration.blocks.find((item) => item.id === "s11")?.markerMeta?.expectedDuration, "120");

assert.equal(patchAffectsMarkerProjection(patch([
  { op: "update", block: { ...baseline.blocks[2], content: "edited" } },
]), baseline), false);
assert.equal(patchAffectsMarkerProjection(patch([
  { op: "update", block: { ...baseline.blocks[1], markerMeta: { name: "renamed" } } },
]), baseline), true);
const rehearsalState = state([block("r0", "rehearsal_marker")]);
assert.equal(patchAffectsMarkerProjection(patch([
  { op: "update", block: { ...rehearsalState.blocks[0], content: "ignored by projection" } },
]), rehearsalState), false);
assert.equal(patchAffectsMarkerProjection(patch([
  { op: "insert", block: block("r1", "rehearsal_marker"), afterId: null },
]), rehearsalState), true);
assert.equal(patchAffectsMarkerProjection(patch([
  { op: "delete", id: "r0" },
]), rehearsalState), true);
assert.equal(patchAffectsMarkerProjection(patch([
  { op: "reorder", ids: baseline.blocks.map((item) => item.id) },
]), baseline), false);

console.log("marker transition fixtures passed");
