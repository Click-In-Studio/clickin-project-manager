import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  convertMarker, executeMarkerDeletion, getMarkerChange, insertHierarchyMarker, insertMarker, markerCacheUpdateBlockIds, normalizeMarkerState, normalizeMarkerStateAfterEdit, normalizeScriptMarkerInvariants, planMarkerDeletion, projectMarkers, resolveMarkerId, updateMarkerMeta,
} from "../lib/script-marker-domain";
import { DEFAULT_SCRIPT_CONFIG, type Block, type ScriptState } from "../lib/script-types";
import { diffState, patchAffectsMarkerProjection, type ScriptPatch } from "../lib/script-ops";
import { buildMarkerContextById, withLegacyOwnershipProjection, withMarkerOwnership } from "../lib/script-marker-blocks";
import { buildMarkerLabelIndex } from "../lib/script-generated-labels";
import { migrateLegacyRehearsalMentions } from "../lib/mention-types";
import { updateMarkerOwnership } from "../lib/script-marker-ownership-cache";
import { getMarkerLabelIndex } from "../lib/db";
import { computePageMap, updateEstimatedPageMap } from "../lib/script-page";

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

const baselineLabels = buildMarkerLabelIndex(withMarkerOwnership([
  ...baseline.blocks,
  block("r11a", "rehearsal_marker"),
]));
assert.equal(baselineLabels.labelByMarkerId.get("c0"), "0");
assert.equal(baselineLabels.labelByMarkerId.get("s11"), "1-1");
assert.equal(baselineLabels.labelByMarkerId.get("r11a"), "2-1-A");
assert.equal(baselineLabels.rehearsalLabelByMarkerId.get("r11a"), "A");
assert.equal(baselineLabels.markerIdByParentAndLabel.get("s21\u0000A"), "r11a");

const wideChapterLabels = buildMarkerLabelIndex(Array.from({ length: 11 }, (_, index) =>
  block(`wide-${index}`, "chapter_marker")
));
assert.equal(wideChapterLabels.labelByMarkerId.get("wide-0"), "00");
assert.equal(wideChapterLabels.labelByMarkerId.get("wide-10"), "10");

const generatedLocalMarkerState = normalizeMarkerState(state([
  block("chapter-generated", "chapter_marker"),
  block("scene-generated", "scene_marker"),
]), createId);
assert.equal(projectMarkers(generatedLocalMarkerState)[0]?.number, "0");
assert.equal(projectMarkers(generatedLocalMarkerState)[1]?.number, "0-1");

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

const chapterWithLaterRehearsal = normalizeMarkerState(state([
  block("c-leading", "chapter_marker"),
  block("t-leading", "dialogue", "text", null),
  block("r-later", "rehearsal_marker", "", null),
  block("t-after-r", "dialogue", "text", null),
]), createId);
assert.equal(chapterWithLaterRehearsal.blocks[1].type, "rehearsal_marker");
assert.equal(chapterWithLaterRehearsal.blocks[1].markerMeta?.parentMarkerId, "c-leading");

const sceneWithLaterRehearsal = normalizeMarkerState(state([
  block("c-scene-leading", "chapter_marker"),
  block("s-leading", "scene_marker"),
  block("t-scene-leading", "dialogue", "text", null),
  block("r-scene-later", "rehearsal_marker", "", null),
  block("t-scene-after-r", "dialogue", "text", null),
]), createId);
const sceneLeadingIndex = sceneWithLaterRehearsal.blocks.findIndex((item) => item.id === "s-leading");
assert.equal(sceneWithLaterRehearsal.blocks[sceneLeadingIndex + 1].type, "rehearsal_marker");
assert.equal(sceneWithLaterRehearsal.blocks[sceneLeadingIndex + 1].markerMeta?.parentMarkerId, "s-leading");

const contentEdited = baseline.blocks.map((item) => item.id === "t11" ? { ...item, content: "edited" } : item);
assert.deepEqual(getMarkerChange(baseline.blocks, contentEdited), { changes: [], positions: [], markerStructureChanged: false });
const contentEditState = { ...baseline, blocks: contentEdited };
assert.equal(normalizeMarkerStateAfterEdit(baseline, contentEditState, createId), contentEditState);
const insertedTextBlocks = [...baseline.blocks];
insertedTextBlocks.splice(3, 0, block("t-inserted", "dialogue", "inserted", null));
assert.deepEqual(getMarkerChange(baseline.blocks, insertedTextBlocks), {
  changes: [{ kind: "insert", position: 3, blockId: "t-inserted", beforeType: null, afterType: "dialogue" }],
  positions: [3],
  markerStructureChanged: false,
});
const markerRenamed = baseline.blocks.map((item) => item.id === "s11"
  ? { ...item, markerMeta: { ...item.markerMeta, name: "renamed", synopsis: "details" } }
  : item);
assert.deepEqual(getMarkerChange(baseline.blocks, markerRenamed), { changes: [], positions: [], markerStructureChanged: false });

const unrelatedInvalidBlocks = [
  block("unrelated-chapter", "chapter_marker"),
  block("unrelated-text-1", "dialogue", "one", null),
  block("unrelated-text-2", "dialogue", "two", null),
  block("unrelated-text-3", "dialogue", "three", null),
  block("unrelated-rehearsal", "rehearsal_marker", "", null),
  block("unrelated-text-4", "dialogue", "four", null),
];
const unrelatedEditedBlocks = [...unrelatedInvalidBlocks];
unrelatedEditedBlocks.splice(2, 0, block("unrelated-insert", "dialogue", "insert", null));
const unrelatedScoped = normalizeScriptMarkerInvariants(
  state(unrelatedEditedBlocks),
  createId,
  { mode: "scoped", ...getMarkerChange(unrelatedInvalidBlocks, unrelatedEditedBlocks) },
);
assert.equal(unrelatedScoped.blocks[1].type, "dialogue");

const missingOpeningBlocks = [
  block("missing-opening-text-1", "dialogue", "one", null),
  block("missing-opening-text-2", "dialogue", "two", null),
  block("missing-opening-text-3", "dialogue", "three", null),
];
const missingOpeningEdited = [...missingOpeningBlocks, block("missing-opening-insert", "dialogue", "four", null)];
const missingOpeningScoped = normalizeScriptMarkerInvariants(
  state(missingOpeningEdited),
  createId,
  { mode: "scoped", ...getMarkerChange(missingOpeningBlocks, missingOpeningEdited) },
);
assert.equal(missingOpeningScoped.blocks[0].id, "missing-opening-text-1");
const reordered = [...baseline.blocks];
reordered.splice(7, 0, reordered.splice(4, 1)[0]);
assert.ok(getMarkerChange(baseline.blocks, reordered).positions.length > 0);
const normalizedBaselineForScope = normalizeMarkerState(baseline, createId);
const normalizedReorderedBlocks = [...normalizedBaselineForScope.blocks];
const movedScopeBlockIndex = normalizedReorderedBlocks.findIndex((item) => item.id === "s11");
normalizedReorderedBlocks.splice(7, 0, normalizedReorderedBlocks.splice(movedScopeBlockIndex, 1)[0]);
const normalizedReorder = normalizeMarkerStateAfterEdit(
  normalizedBaselineForScope,
  { ...normalizedBaselineForScope, blocks: normalizedReorderedBlocks },
  createId,
);
const unchangedText = normalizedReorder.blocks.find((item) => item.id === "t01");
assert.equal(unchangedText, normalizedBaselineForScope.blocks.find((item) => item.id === "t01"));

const pageCache = updateEstimatedPageMap(null, normalizedBaselineForScope.blocks, "a4", "center", true, "full");
const paginationMetadataEdit = normalizedBaselineForScope.blocks.map((item) => item.id === "t11"
  ? { ...item, markerMeta: { ...item.markerMeta, synopsis: "detail only" } }
  : item);
assert.equal(
  updateEstimatedPageMap(pageCache, paginationMetadataEdit, "a4", "center", true, { start: 4, end: 5 }),
  pageCache,
);
assert.equal(
  updateEstimatedPageMap(pageCache, paginationMetadataEdit, "a4", "center", true, null),
  pageCache,
);
const sameHeightContentEdit = normalizedBaselineForScope.blocks.map((item) => item.id === "t11"
  ? { ...item, content: "replacement" }
  : item);
assert.equal(
  updateEstimatedPageMap(pageCache, sameHeightContentEdit, "a4", "center", true, { start: 4, end: 5 }),
  pageCache,
);
const tallerContentEdit = normalizedBaselineForScope.blocks.map((item) => item.id === "t11"
  ? { ...item, content: "very long ".repeat(500) }
  : item);
const tallerPageCache = updateEstimatedPageMap(
  pageCache,
  tallerContentEdit,
  "a4",
  "center",
  true,
  { start: 4, end: 5 },
);
assert.notEqual(tallerPageCache, pageCache);
assert.deepEqual(tallerPageCache.pageMap, computePageMap(tallerContentEdit, "a4", "center", true));
const unknownRangeTallerPageCache = updateEstimatedPageMap(
  pageCache,
  tallerContentEdit,
  "a4",
  "center",
  true,
  null,
);
assert.notEqual(unknownRangeTallerPageCache, pageCache);
assert.deepEqual(unknownRangeTallerPageCache.pageMap, computePageMap(tallerContentEdit, "a4", "center", true));

const overlappingPaginationBlocks = [
  block("page-overlap-0", "dialogue", "zero", null),
  block("page-overlap-1", "dialogue", "one", null),
  block("page-overlap-2", "dialogue", "two", null),
  block("page-overlap-3", "dialogue", "three", null),
];
const overlappingPageCache = updateEstimatedPageMap(
  null,
  overlappingPaginationBlocks,
  "a4",
  "center",
  true,
  "full",
);
const overlappingPaginationEdit = overlappingPaginationBlocks.map((item) => item.id === "page-overlap-3"
  ? { ...item, content: "very long ".repeat(500) }
  : item);
const overlappingRangePageCache = updateEstimatedPageMap(
  overlappingPageCache,
  overlappingPaginationEdit,
  "a4",
  "center",
  true,
  [{ start: 1, end: 2 }, { start: 2, end: 3 }],
);
assert.notEqual(overlappingRangePageCache, overlappingPageCache);
assert.deepEqual(overlappingRangePageCache.pageMap, computePageMap(overlappingPaginationEdit, "a4", "center", true));
assert.deepEqual(
  updateEstimatedPageMap(
    overlappingPageCache,
    overlappingPaginationEdit,
    "a4",
    "center",
    true,
    [{ start: 1, end: 3 }, { start: 2, end: 4 }],
  ).pageMap,
  computePageMap(overlappingPaginationEdit, "a4", "center", true),
);

const markerOnlyPaginationBlocks = [...normalizedBaselineForScope.blocks];
markerOnlyPaginationBlocks.splice(5, 0, block("pagination-marker", "rehearsal_marker", "", null));
const markerOnlyPaginationOwned = withMarkerOwnership(markerOnlyPaginationBlocks);
const markerOnlyPageCache = updateEstimatedPageMap(
  pageCache,
  markerOnlyPaginationOwned,
  "a4",
  "center",
  true,
  { start: 5, end: 6 },
);
assert.equal(markerOnlyPageCache, pageCache);
const tallerAfterMarkerInsert = markerOnlyPaginationOwned.map((item) => item.id === "t11"
  ? { ...item, content: "very long ".repeat(500) }
  : item);
assert.deepEqual(
  updateEstimatedPageMap(markerOnlyPageCache, tallerAfterMarkerInsert, "a4", "center", true, { start: 6, end: 7 }).pageMap,
  computePageMap(tallerAfterMarkerInsert, "a4", "center", true),
);

function assertScopedMatchesFull(previous: ScriptState, editedBlocks: Block[]): ScriptState {
  let fullId = 0;
  let scopedId = 0;
  const edited = { ...previous, blocks: editedBlocks };
  const full = normalizeMarkerState(edited, () => `oracle-${++fullId}`);
  const scoped = normalizeMarkerStateAfterEdit(previous, edited, () => `oracle-${++scopedId}`);
  assert.deepEqual(scoped, full);
  return scoped;
}

const leadingRepairBaseline = normalizeMarkerState(state([
  block("c-oracle", "chapter_marker"),
  block("r-oracle-leading", "rehearsal_marker", "", null),
  block("r-oracle-later", "rehearsal_marker", "", null),
  block("s-oracle", "scene_marker"),
  block("r-scene-oracle-leading", "rehearsal_marker", "", null),
  block("t-scene-oracle", "dialogue", "text", null),
  block("r-scene-oracle-later", "rehearsal_marker", "", null),
  block("t-scene-oracle-later", "dialogue", "text", null),
]), createId);
const withoutBothLeadingMarkers = leadingRepairBaseline.blocks.filter((item) =>
  item.id !== "r-oracle-leading" && item.id !== "r-scene-oracle-leading");
const repairedLeadingMarkers = assertScopedMatchesFull(leadingRepairBaseline, withoutBothLeadingMarkers);
const laterChapterRehearsalIndex = repairedLeadingMarkers.blocks.findIndex((item) => item.id === "r-oracle-later");
let repairedChapterBoundaryIndex = laterChapterRehearsalIndex - 1;
while (
  repairedChapterBoundaryIndex >= 0 &&
  repairedLeadingMarkers.blocks[repairedChapterBoundaryIndex].type !== "chapter_marker" &&
  repairedLeadingMarkers.blocks[repairedChapterBoundaryIndex].type !== "scene_marker"
) repairedChapterBoundaryIndex--;
assert.equal(repairedLeadingMarkers.blocks[repairedChapterBoundaryIndex + 1].type, "rehearsal_marker");
const repairedSceneIndex = repairedLeadingMarkers.blocks.findIndex((item) => item.id === "s-oracle");
assert.equal(repairedLeadingMarkers.blocks[repairedSceneIndex + 1].type, "rehearsal_marker");

const convertedOracleBlocks = repairedLeadingMarkers.blocks.map((item) => item.id === "s-oracle"
  ? { ...item, type: "chapter_marker" as const, markerMeta: { ...item.markerMeta, parentMarkerId: null } }
  : item);
assertScopedMatchesFull(repairedLeadingMarkers, convertedOracleBlocks);

const insertedChapterBlocks = [...normalizedBaselineForScope.blocks];
insertedChapterBlocks.splice(6, 0, block("c-insert-oracle", "chapter_marker"));
const insertedChapterResult = assertScopedMatchesFull(normalizedBaselineForScope, insertedChapterBlocks);
assert.equal(
  insertedChapterResult.blocks.find((item) => item.id === "c2"),
  normalizedBaselineForScope.blocks.find((item) => item.id === "c2"),
);

const deletedSceneBlocks = normalizedBaselineForScope.blocks.filter((item) => item.id !== "s11");
const deletedSceneChange = getMarkerChange(normalizedBaselineForScope.blocks, deletedSceneBlocks);
assert.equal(deletedSceneChange.markerStructureChanged, true);
assert.ok(deletedSceneChange.changes.some((item) =>
  item.kind === "delete" && item.blockId === "s11" && item.beforeType === "scene_marker"));
const deletedSceneResult = assertScopedMatchesFull(normalizedBaselineForScope, deletedSceneBlocks);
assert.equal(deletedSceneResult.blocks.find((item) => item.id === "t11")?.ownerMarkerId, "c1");
assert.equal(
  deletedSceneResult.blocks.find((item) => item.id === "t21"),
  normalizedBaselineForScope.blocks.find((item) => item.id === "t21"),
);

const movedMarkerBlocks = [...normalizedBaselineForScope.blocks];
const movedMarkerIndex = movedMarkerBlocks.findIndex((item) => item.id === "s21");
const [movedMarker] = movedMarkerBlocks.splice(movedMarkerIndex, 1);
movedMarkerBlocks.splice(3, 0, movedMarker);
assertScopedMatchesFull(normalizedBaselineForScope, movedMarkerBlocks);

const explicitMovePrevious = [
  block("move-chapter-1", "chapter_marker"),
  block("move-text-1", "dialogue", "one", null),
  block("move-text-2", "dialogue", "two", null),
  block("move-chapter-2", "chapter_marker"),
  block("move-text-3", "dialogue", "three", null),
];
const explicitMoveNext = [
  explicitMovePrevious[0],
  explicitMovePrevious[3],
  explicitMovePrevious[4],
  explicitMovePrevious[1],
  explicitMovePrevious[2],
];
const explicitMoveChange = getMarkerChange(
  explicitMovePrevious,
  explicitMoveNext,
  ["move-text-1", "move-text-2"],
);
assert.deepEqual(
  [...new Set(explicitMoveChange.changes
    .filter((change) => change.kind === "move-source" || change.kind === "move-target")
    .map((change) => change.blockId))],
  ["move-text-1", "move-text-2"],
);

const hierarchyOnlyPrevious = [
  block("hierarchy-chapter", "chapter_marker"),
  { ...block("hierarchy-scene", "scene_marker"), markerMeta: { parentMarkerId: null } },
  block("hierarchy-text", "dialogue", "text", null),
];
const hierarchyOnlyNext = hierarchyOnlyPrevious.map((item) => item.id === "hierarchy-scene"
  ? { ...item, markerMeta: { parentMarkerId: "hierarchy-chapter" } }
  : item);
assert.deepEqual(
  markerCacheUpdateBlockIds(
    hierarchyOnlyNext,
    getMarkerChange(hierarchyOnlyPrevious, hierarchyOnlyNext),
  ),
  ["hierarchy-scene"],
);

const ordinaryInsertBlocks = [...normalizedBaselineForScope.blocks];
ordinaryInsertBlocks.splice(3, 0, block("ordinary-scope", "dialogue", "text", null));
const ordinaryInsertResult = assertScopedMatchesFull(normalizedBaselineForScope, ordinaryInsertBlocks);
assert.equal(ordinaryInsertResult.scenes, normalizedBaselineForScope.scenes);
assert.equal(ordinaryInsertResult.blocks.find((item) => item.id === "ordinary-scope")?.ownerMarkerId, "s01");
assert.equal(
  ordinaryInsertResult.blocks.find((item) => item.id === "t11"),
  normalizedBaselineForScope.blocks.find((item) => item.id === "t11"),
);
assert.deepEqual(
  markerCacheUpdateBlockIds(
    ordinaryInsertResult.blocks,
    getMarkerChange(normalizedBaselineForScope.blocks, ordinaryInsertResult.blocks),
  ),
  ["ordinary-scope"],
);
assert.deepEqual(
  markerCacheUpdateBlockIds(deletedSceneResult.blocks, deletedSceneChange),
  ["t11"],
);
const adjacentMarkerPrevious = [
  block("adjacent-chapter", "chapter_marker"),
  block("adjacent-scene", "scene_marker"),
  block("adjacent-text", "dialogue", "text", null),
];
const adjacentMarkerNext = adjacentMarkerPrevious.slice(1);
assert.deepEqual(
  markerCacheUpdateBlockIds(adjacentMarkerNext, getMarkerChange(adjacentMarkerPrevious, adjacentMarkerNext)),
  ["adjacent-scene"],
);

const sameOrderMarkerMoveBlocks = [...normalizedBaselineForScope.blocks];
const sameOrderMarkerIndex = sameOrderMarkerMoveBlocks.findIndex((item) => item.id === "s11");
const [sameOrderMarker] = sameOrderMarkerMoveBlocks.splice(sameOrderMarkerIndex, 1);
const sameOrderTargetIndex = sameOrderMarkerMoveBlocks.findIndex((item) => item.id === "t11") + 1;
sameOrderMarkerMoveBlocks.splice(sameOrderTargetIndex, 0, sameOrderMarker);
assert.equal(getMarkerChange(normalizedBaselineForScope.blocks, sameOrderMarkerMoveBlocks).markerStructureChanged, false);
const sameOrderMarkerMoveResult = assertScopedMatchesFull(normalizedBaselineForScope, sameOrderMarkerMoveBlocks);
assert.notEqual(sameOrderMarkerMoveResult.scenes, normalizedBaselineForScope.scenes);

const sameOrderRehearsalMoveBlocks = [...leadingRepairBaseline.blocks];
const sameOrderRehearsalIndex = sameOrderRehearsalMoveBlocks.findIndex((item) => item.id === "r-scene-oracle-later");
const [sameOrderRehearsal] = sameOrderRehearsalMoveBlocks.splice(sameOrderRehearsalIndex, 1);
const sameOrderRehearsalTarget = sameOrderRehearsalMoveBlocks.findIndex((item) => item.id === "t-scene-oracle-later") + 1;
sameOrderRehearsalMoveBlocks.splice(sameOrderRehearsalTarget, 0, sameOrderRehearsal);
assert.equal(getMarkerChange(leadingRepairBaseline.blocks, sameOrderRehearsalMoveBlocks).markerStructureChanged, false);
const sameOrderRehearsalMoveResult = assertScopedMatchesFull(leadingRepairBaseline, sameOrderRehearsalMoveBlocks);
assert.equal(sameOrderRehearsalMoveResult.scenes, leadingRepairBaseline.scenes);
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

const firstHierarchySceneWithText = insertHierarchyMarker(state([
  block("c0", "chapter_marker"),
  block("chapter-text", "dialogue", "chapter text", null),
  block("c1", "chapter_marker"),
  block("s11", "scene_marker"),
]), { kind: "scene", parentId: "c0", beforeId: "c1", name: "first scene" }, createId);
const firstHierarchySceneWithTextProjection = projectMarkers(firstHierarchySceneWithText);
const firstHierarchySceneWithTextId = firstHierarchySceneWithTextProjection.find((item) => item.name === "first scene")?.id;
assert.ok(firstHierarchySceneWithTextId);
assert.equal(firstHierarchySceneWithTextProjection.filter((item) => item.kind === "scene" && item.parentId === "c0").length, 1);
assert.equal(firstHierarchySceneWithText.blocks.findIndex((item) => item.id === firstHierarchySceneWithTextId), 1);

const firstHierarchySceneWithEmptyBlock = insertHierarchyMarker(state([
  block("c0", "chapter_marker"),
  block("chapter-empty", "dialogue", "", null),
  block("c1", "chapter_marker"),
  block("s11", "scene_marker"),
]), { kind: "scene", parentId: "c0", beforeId: "c1", name: "first empty scene" }, createId);
assert.equal(projectMarkers(firstHierarchySceneWithEmptyBlock).filter((item) => item.kind === "scene" && item.parentId === "c0").length, 1);

const existingHierarchyScene = insertHierarchyMarker(
  baseline,
  { kind: "scene", parentId: "c1", beforeId: "c2", name: "existing chapter scene" },
  createId,
);
const existingHierarchySceneId = projectMarkers(existingHierarchyScene).find((item) => item.name === "existing chapter scene")?.id;
assert.ok(existingHierarchySceneId);
assert.equal(
  existingHierarchyScene.blocks.findIndex((item) => item.id === existingHierarchySceneId) + 2,
  existingHierarchyScene.blocks.findIndex((item) => item.id === "c2"),
);

const directFirstSceneInsertion = insertMarker(state([
  block("c0", "chapter_marker"),
  block("chapter-text", "dialogue", "chapter text", null),
  block("c1", "chapter_marker"),
  block("s11", "scene_marker"),
]), { kind: "scene", parentId: "c0", beforeId: "c1", name: "direct insertion" }, createId);
assert.equal(projectMarkers(directFirstSceneInsertion).filter((item) => item.kind === "scene" && item.parentId === "c0").length, 2);

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
assert.equal(buildMarkerLabelIndex(reparented.blocks).labelByMarkerId.get("s11"), "0-2");

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

const ownedRehearsalBlocks = withMarkerOwnership([
  block("scene", "scene_marker"),
  block("mark-a", "rehearsal_marker"),
  block("text-a", "dialogue", "one", null),
  block("mark-b", "rehearsal_marker"),
  block("text-b", "dialogue", "two", null),
]);
assert.equal(ownedRehearsalBlocks.find((item) => item.id === "text-b")?.rehearsalMark, null);
assert.equal(ownedRehearsalBlocks.find((item) => item.id === "text-b")?.ownerMarkerId, "mark-b");
assert.equal(ownedRehearsalBlocks.find((item) => item.id === "mark-b")?.ownerMarkerId, undefined);
assert.equal(ownedRehearsalBlocks.find((item) => item.id === "mark-b")?.markerMeta?.parentMarkerId, "scene");
assert.equal(buildMarkerLabelIndex(ownedRehearsalBlocks).rehearsalLabelByMarkerId.get("mark-b"), "B");

const contextBlocks = withMarkerOwnership([
  block("chapter", "chapter_marker"),
  block("scene-context", "scene_marker"),
  block("mark-context", "rehearsal_marker"),
  block("mark-text", "dialogue", "marked", null),
]);
const markerContextById = buildMarkerContextById(contextBlocks);
assert.equal(updateMarkerOwnership(contextBlocks, null), contextBlocks);
assert.deepEqual(markerContextById.get("chapter"), {
  chapterId: "chapter", sceneId: "chapter", rehearsalId: null,
});
assert.deepEqual(markerContextById.get("mark-context"), {
  chapterId: "chapter", sceneId: "scene-context", rehearsalId: "mark-context",
});
const serializedOwnershipPatch = diffState(null, state(contextBlocks), 1);
const serializedMarkText = serializedOwnershipPatch.blockOps.find(
  (op) => op.op === "insert" && op.block.id === "mark-text",
);
assert.equal(
  serializedMarkText?.op === "insert" ? serializedMarkText.block.ownerMarkerId : null,
  "mark-context",
);
assert.equal(serializedMarkText?.op === "insert" ? serializedMarkText.block.sceneId : null, "scene-context");
assert.equal(serializedMarkText?.op === "insert" ? serializedMarkText.block.rehearsalMark : null, "mark-context");
const insertedText = block("inserted-text", "dialogue", "inserted", null);
const incrementallyOwned = updateMarkerOwnership(
  [...contextBlocks, insertedText],
  { start: contextBlocks.length, end: contextBlocks.length + 1 },
);
assert.equal(incrementallyOwned.at(-1)?.ownerMarkerId, "mark-context");
const untouchedFollowingText = block("untouched-following", "dialogue", "unchanged", null);
const exactlyOwned = updateMarkerOwnership(
  [...contextBlocks, insertedText, untouchedFollowingText],
  { start: contextBlocks.length, end: contextBlocks.length + 1, throughNextMarker: false },
);
assert.equal(exactlyOwned[contextBlocks.length].ownerMarkerId, "mark-context");
assert.equal(exactlyOwned.at(-1), untouchedFollowingText);

const insertedRehearsalBlocks = withMarkerOwnership([
  ...ownedRehearsalBlocks.slice(0, 3),
  block("mark-new", "rehearsal_marker"),
  block("text-new", "dialogue", "new", null),
  ...ownedRehearsalBlocks.slice(3),
]);
const insertedLabelIndex = buildMarkerLabelIndex(insertedRehearsalBlocks);
const insertedLabels = insertedLabelIndex.rehearsalLabelByMarkerId;
assert.equal(insertedLabels.get("mark-new"), "B");
assert.equal(insertedLabels.get("mark-b"), "C");
assert.equal(insertedLabelIndex.markerIdByParentAndLabel.get("scene\u0000B"), "mark-new");
assert.equal(insertedLabelIndex.markerIdByParentAndLabel.get("scene\u0000C"), "mark-b");
assert.equal(insertedRehearsalBlocks.find((item) => item.id === "text-b")?.ownerMarkerId, "mark-b");

const staleRehearsalCache = [
  block("scene-1", "scene_marker"),
  { ...block("mark-1", "rehearsal_marker"), rehearsalMark: "A" },
  { ...block("text-1", "dialogue", "one", null), rehearsalMark: "A" },
  block("scene-2", "scene_marker"),
  block("mark-2", "rehearsal_marker"),
  block("text-2", "dialogue", "two", null),
];
const derivedRehearsalCache = withMarkerOwnership(staleRehearsalCache);
assert.equal(derivedRehearsalCache.find((item) => item.id === "text-1")?.ownerMarkerId, "mark-1");
assert.equal(derivedRehearsalCache.find((item) => item.id === "text-1")?.rehearsalMark, "A");
assert.equal(derivedRehearsalCache.find((item) => item.id === "mark-1")?.ownerMarkerId, undefined);
assert.equal(derivedRehearsalCache.find((item) => item.id === "mark-1")?.rehearsalMark, "A");
const normalizedRehearsalCache = withLegacyOwnershipProjection(derivedRehearsalCache);
assert.deepEqual(
  normalizedRehearsalCache.map(({ id, sceneId, rehearsalMark, markerMeta }) => ({
    id, sceneId, rehearsalMark, parentId: markerMeta?.parentMarkerId,
  })),
  [
    { id: "scene-1", sceneId: "scene-1", rehearsalMark: null, parentId: null },
    { id: "mark-1", sceneId: null, rehearsalMark: null, parentId: "scene-1" },
    { id: "text-1", sceneId: "scene-1", rehearsalMark: "mark-1", parentId: undefined },
    { id: "scene-2", sceneId: "scene-2", rehearsalMark: null, parentId: null },
    { id: "mark-2", sceneId: null, rehearsalMark: null, parentId: "scene-2" },
    { id: "text-2", sceneId: "scene-2", rehearsalMark: "mark-2", parentId: undefined },
  ],
);
const normalizedLabels = buildMarkerLabelIndex(normalizedRehearsalCache);
assert.equal(normalizedLabels.rehearsalLabelByMarkerId.get("mark-1"), "A");
assert.equal(normalizedLabels.rehearsalLabelByMarkerId.get("mark-2"), "A");

const legacyMentionMappings = [{ sceneId: "scene-1", label: "A", markerId: "mark-1" }];
assert.equal(
  migrateLegacyRehearsalMentions(
    "before [#rehearsal:scene-1:A] after",
    "version-1",
    legacyMentionMappings,
    true,
  ),
  "before [#rehearsal:mark-1] after",
);
assert.equal(
  migrateLegacyRehearsalMentions(
    "[#A](/__cm__rehearsal:scene-1?v=version-1:A)",
    "version-1",
    legacyMentionMappings,
    false,
  ),
  "[#A](/__cm__rehearsal:mark-1?v=version-1)",
);
assert.equal(
  migrateLegacyRehearsalMentions(
    "[#rehearsal:scene-1:A]",
    "version-1",
    legacyMentionMappings,
    false,
  ),
  "[#rehearsal:scene-1:A]",
);
assert.equal(
  migrateLegacyRehearsalMentions(
    "[#AA](/__cm__rehearsal:scene-1:AA)",
    "version-1",
    [
      ...legacyMentionMappings,
      { sceneId: "scene-1", label: "AA", markerId: "mark-27" },
    ],
    true,
  ),
  "[#AA](/__cm__rehearsal:mark-27)",
);

type FakeMarker = {
  id: string;
  type: "chapter_marker" | "scene_marker" | "rehearsal_marker";
  parentMarkerId: string | null;
};

class FakeMarkerPool {
  readonly versions = new Map<string, { revision: string; markers: FakeMarker[] }>();
  readonly markerLoads = new Map<string, number>();
  delayedVersionId: string | null = null;

  async query(sql: string, params: unknown[]) {
    const versionId = params[0] as string;
    const version = this.versions.get(versionId);
    if (sql.includes("LEFT JOIN LATERAL")) {
      this.markerLoads.set(versionId, (this.markerLoads.get(versionId) ?? 0) + 1);
      if (this.delayedVersionId === versionId) await new Promise((resolve) => setTimeout(resolve, 0));
      if (!version) return { rows: [] };
      return {
        rows: version.markers.length > 0
          ? version.markers.map((marker) => ({
              revision: version.revision,
              id: marker.id,
              type: marker.type,
              parent_marker_id: marker.parentMarkerId,
            }))
          : [{ revision: version.revision, id: null, type: null, parent_marker_id: null }],
      };
    }
    if (sql.includes("marker_structure_revision")) {
      return { rows: version ? [{ revision: version.revision }] : [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

async function verifyMarkerLabelCache() {
  const fake = new FakeMarkerPool();
  const pool = fake as unknown as Pool;
  const versionId = "cache-version";
  fake.versions.set(versionId, {
    revision: "0",
    markers: [
      { id: "cache-chapter", type: "chapter_marker", parentMarkerId: null },
      { id: "cache-scene", type: "scene_marker", parentMarkerId: "cache-chapter" },
    ],
  });

  const first = await getMarkerLabelIndex(versionId, pool);
  const second = await getMarkerLabelIndex(versionId, pool);
  assert.equal(first, second);
  assert.equal(fake.markerLoads.get(versionId), 1);

  fake.versions.set(versionId, {
    revision: "1",
    markers: [
      { id: "cache-chapter", type: "chapter_marker", parentMarkerId: null },
      { id: "cache-scene", type: "scene_marker", parentMarkerId: "cache-chapter" },
      { id: "cache-scene-2", type: "scene_marker", parentMarkerId: "cache-chapter" },
    ],
  });
  const rebuilt = await getMarkerLabelIndex(versionId, pool);
  assert.notEqual(rebuilt, first);
  assert.equal(rebuilt.labelByMarkerId.get("cache-scene-2"), "0-2");
  assert.equal(fake.markerLoads.get(versionId), 2);

  const concurrentVersionId = "cache-concurrent";
  fake.versions.set(concurrentVersionId, {
    revision: "0",
    markers: [{ id: "concurrent-chapter", type: "chapter_marker", parentMarkerId: null }],
  });
  fake.delayedVersionId = concurrentVersionId;
  const [concurrentA, concurrentB] = await Promise.all([
    getMarkerLabelIndex(concurrentVersionId, pool),
    getMarkerLabelIndex(concurrentVersionId, pool),
  ]);
  assert.equal(concurrentA, concurrentB);
  assert.equal(fake.markerLoads.get(concurrentVersionId), 1);

  for (let index = 0; index <= 64; index++) {
    const id = `cache-eviction-${index}`;
    fake.versions.set(id, {
      revision: "0",
      markers: [{ id: `${id}-chapter`, type: "chapter_marker", parentMarkerId: null }],
    });
    await getMarkerLabelIndex(id, pool);
  }
  await getMarkerLabelIndex("cache-eviction-0", pool);
  assert.equal(fake.markerLoads.get("cache-eviction-0"), 2);
}

verifyMarkerLabelCache()
  .then(() => console.log("marker transition fixtures passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
