import { buildMarkerLabelIndex, type MarkerLabelIndex } from "./script-generated-labels";
import { isMarkerBlock, markerBlockRank, shouldInsertEmptyBlockAfterMarker, withMarkerOwnership } from "./script-marker-blocks";
import { updateMarkerOwnership, type MarkerOwnershipRange } from "./script-marker-ownership-cache";
import { FIXED_INITIAL_CHAPTER_NAME } from "./script-fixed-markers";
import type { Block, BlockType, MarkerMeta, Scene, ScriptState } from "./script-types";

export type MarkerKind = "chapter" | "scene";

type MarkerDetailFields = {
  synopsis: string;
  actionLine: string;
  music: string;
  stageNotes: string;
  expectedDuration: string;
};

export type MarkerProjection = Scene & MarkerDetailFields & {
  kind: MarkerKind;
  rehearsalMarks: string[];
};

type MarkerInsert = {
  kind: MarkerKind;
  name?: string;
  parentId?: string | null;
  beforeId?: string | null;
  afterId?: string | null;
  beforeBlockId?: string | null;
  afterBlockId?: string | null;
};

export type MarkerDeleteOperation =
  | { type: "marker-only"; markerId: string }
  | { type: "whole"; markerId: string };

export type MarkerDeletePlan =
  | { status: "blocked"; kind: MarkerKind; message: string }
  | { status: "choice"; options: MarkerDeleteOperation[]; previewBlockIds: string[] }
  | { status: "ready"; operation: MarkerDeleteOperation; previewBlockIds: string[] };

type IdFactory = () => string;

export type MarkerChange = {
  changes: BlockChange[];
  positions: number[];
  markerStructureChanged: boolean;
  ownershipBlockIds?: string[];
};

export type BlockChange = {
  kind: "insert" | "delete" | "move-source" | "move-target" | "convert" | "structure";
  position: number;
  blockId: string;
  beforeType: BlockType | null;
  afterType: BlockType | null;
};

export type MarkerNormalizationScope =
  | { mode: "full" }
  | ({ mode: "scoped" } & MarkerChange);

function removalPositions(
  previous: Block[],
  nextIndexById: ReadonlyMap<string, number>,
  nextLength: number,
): number[] {
  const positions = new Array<number>(previous.length).fill(-1);
  let adjacentPosition: number | undefined;
  for (let index = previous.length - 1; index >= 0; index--) {
    if (adjacentPosition !== undefined) positions[index] = adjacentPosition;
    const currentPosition = nextIndexById.get(previous[index].id);
    if (currentPosition !== undefined) adjacentPosition = currentPosition;
  }
  adjacentPosition = undefined;
  for (let index = 0; index < previous.length; index++) {
    if (positions[index] < 0) {
      positions[index] = adjacentPosition === undefined
        ? 0
        : Math.min(nextLength, adjacentPosition + 1);
    }
    const currentPosition = nextIndexById.get(previous[index].id);
    if (currentPosition !== undefined) adjacentPosition = currentPosition;
  }
  return positions;
}

function movedIds(previousIds: string[], nextIds: string[]): Set<string> {
  if (previousIds.every((id, index) => nextIds[index] === id)) return new Set();
  const nextIndexById = new Map(nextIds.map((id, index) => [id, index]));
  const tails: number[] = [];
  const tailIndexes: number[] = [];
  const predecessors = new Array<number>(previousIds.length).fill(-1);

  for (let index = 0; index < previousIds.length; index++) {
    const value = nextIndexById.get(previousIds[index]);
    if (value === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) predecessors[index] = tailIndexes[low - 1];
    tails[low] = value;
    tailIndexes[low] = index;
  }

  const retained = new Set<string>();
  let cursor = tailIndexes[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    retained.add(previousIds[cursor]);
    cursor = predecessors[cursor];
  }
  return new Set(previousIds.filter((id) => !retained.has(id)));
}

export function sameMarkerStructure(previous: Block[], next: Block[]): boolean {
  let previousIndex = 0;
  let nextIndex = 0;
  for (;;) {
    while (previousIndex < previous.length && !isMarkerBlock(previous[previousIndex])) previousIndex++;
    while (nextIndex < next.length && !isMarkerBlock(next[nextIndex])) nextIndex++;
    const before = previous[previousIndex];
    const after = next[nextIndex];
    if (!before || !after) return !before && !after;
    if (
      before.id !== after.id ||
      before.type !== after.type ||
      (before.markerMeta?.parentMarkerId ?? null) !== (after.markerMeta?.parentMarkerId ?? null)
    ) return false;
    previousIndex++;
    nextIndex++;
  }
}

export function getMarkerChange(
  previous: Block[],
  next: Block[],
  movedBlockIds?: Iterable<string>,
): MarkerChange {
  const previousIndexById = new Map(previous.map((block, index) => [block.id, index]));
  const nextIndexById = new Map(next.map((block, index) => [block.id, index]));
  let positionAfterRemoval: number[] | null = null;
  const changes: BlockChange[] = [];

  for (let index = 0; index < previous.length; index++) {
    const before = previous[index];
    const nextIndex = nextIndexById.get(before.id);
    if (nextIndex === undefined) {
      positionAfterRemoval ??= removalPositions(previous, nextIndexById, next.length);
      changes.push({
        kind: "delete",
        position: positionAfterRemoval[index],
        blockId: before.id,
        beforeType: before.type,
        afterType: null,
      });
      continue;
    }
    const after = next[nextIndex];
    if (before.type !== after.type) {
      changes.push({
        kind: "convert",
        position: nextIndex,
        blockId: before.id,
        beforeType: before.type,
        afterType: after.type,
      });
    } else if (
      before.sceneId !== after.sceneId ||
      (before.markerMeta?.parentMarkerId ?? null) !== (after.markerMeta?.parentMarkerId ?? null)
    ) {
      changes.push({
        kind: "structure",
        position: nextIndex,
        blockId: before.id,
        beforeType: before.type,
        afterType: after.type,
      });
    }
  }

  for (let index = 0; index < next.length; index++) {
    const after = next[index];
    if (!previousIndexById.has(after.id)) {
      changes.push({
        kind: "insert",
        position: index,
        blockId: after.id,
        beforeType: null,
        afterType: after.type,
      });
    }
  }

  const moved = movedBlockIds === undefined
    ? movedIds(
        previous.filter((block) => nextIndexById.has(block.id)).map((block) => block.id),
        next.filter((block) => previousIndexById.has(block.id)).map((block) => block.id),
      )
    : new Set(movedBlockIds);
  for (const id of moved) {
    const previousIndex = previousIndexById.get(id);
    const nextIndex = nextIndexById.get(id);
    if (previousIndex === undefined || nextIndex === undefined) continue;
    positionAfterRemoval ??= removalPositions(previous, nextIndexById, next.length);
    const type = previous[previousIndex].type;
    changes.push({
      kind: "move-source",
      position: positionAfterRemoval[previousIndex],
      blockId: id,
      beforeType: type,
      afterType: type,
    }, {
      kind: "move-target",
      position: nextIndex,
      blockId: id,
      beforeType: type,
      afterType: next[nextIndex].type,
    });
  }

  return {
    changes,
    positions: [...new Set(changes.map((change) => change.position))].sort((a, b) => a - b),
    markerStructureChanged: !sameMarkerStructure(previous, next),
  };
}

function isSectionMarker(block: Block): boolean {
  return block.type === "chapter_marker" || block.type === "scene_marker";
}

function isEmptyTextBlock(block: Block): boolean {
  return !isMarkerBlock(block) &&
    block.content.trim() === "" &&
    (block.stageComment ?? "").trim() === "" &&
    block.characterIds.length === 0;
}

function hasDetails(meta: MarkerMeta | null | undefined): boolean {
  return [meta?.synopsis, meta?.actionLine, meta?.music, meta?.stageNotes, meta?.expectedDuration]
    .some((value) => typeof value === "string" && value.trim() !== "");
}

function makeTextBlock(id: string): Block {
  return {
    id,
    type: "dialogue",
    content: "",
    characterIds: [],
    characterAnnotations: {},
    forceShowCharacterName: false,
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
  };
}

function makeSectionMarker(id: string, kind: MarkerKind, name: string, parentMarkerId: string | null): Block {
  return {
    ...makeTextBlock(id),
    type: kind === "chapter" ? "chapter_marker" : "scene_marker",
    sceneId: id,
    markerMeta: { name, parentMarkerId },
  };
}

function makeRehearsalMarker(id: string): Block {
  return {
    ...makeTextBlock(id),
    type: "rehearsal_marker",
  };
}

export function resolveMarkerId(state: Pick<ScriptState, "blocks">, id: string): string | null {
  const exact = state.blocks.find((block) => isSectionMarker(block) && block.id === id);
  if (exact) return exact.id;
  return state.blocks.find((block) => isSectionMarker(block) && block.sceneId === id)?.id ?? null;
}

function detailValue(meta: MarkerMeta | null | undefined, key: keyof MarkerDetailFields): string {
  const value = meta?.[key];
  return typeof value === "string" ? value : "";
}

export function projectMarkers(
  state: Pick<ScriptState, "blocks" | "scenes">,
  detailRows: Array<Scene & Partial<MarkerDetailFields>> = state.scenes,
  labelIndex: MarkerLabelIndex = buildMarkerLabelIndex(state.blocks),
): MarkerProjection[] {
  const detailById = new Map(detailRows.map((row) => [row.id, row]));
  const raw: MarkerProjection[] = [];
  let currentChapterId: string | null = null;
  let currentMarker: MarkerProjection | null = null;

  for (const block of state.blocks) {
    if (block.type === "chapter_marker" || block.type === "scene_marker") {
      const kind: MarkerKind = block.type === "chapter_marker" ? "chapter" : "scene";
      if (kind === "chapter") currentChapterId = block.id;
      const fallback = detailById.get(block.id) ?? (block.sceneId ? detailById.get(block.sceneId) : undefined);
      const meta = block.markerMeta;
      currentMarker = {
        id: block.id,
        kind,
        number: "",
        name: meta?.name ?? fallback?.name ?? "",
        parentId: kind === "chapter" ? null : currentChapterId,
        synopsis: detailValue(meta, "synopsis") || fallback?.synopsis || "",
        actionLine: detailValue(meta, "actionLine") || fallback?.actionLine || "",
        music: detailValue(meta, "music") || fallback?.music || "",
        stageNotes: detailValue(meta, "stageNotes") || fallback?.stageNotes || "",
        expectedDuration: detailValue(meta, "expectedDuration") || fallback?.expectedDuration || "",
        rehearsalMarks: [],
      };
      raw.push(currentMarker);
      continue;
    }
    if (block.type === "rehearsal_marker" && currentMarker) {
      const label = labelIndex.rehearsalLabelByMarkerId.get(block.id);
      if (label) currentMarker.rehearsalMarks.push(label);
    }
  }

  return raw.map((marker) => ({
    ...marker,
    number: labelIndex.labelByMarkerId.get(marker.id) ?? "",
  }));
}

function affectedSectionIds(blocks: Block[], positions: Iterable<number>): Set<string> {
  const ids = new Set<string>();
  for (const position of positions) {
    for (let index = Math.max(0, position - 1); index <= Math.min(blocks.length - 1, position + 1); index++) {
      const block = blocks[index];
      if (isSectionMarker(block)) {
        ids.add(block.id);
      } else if (block.type === "rehearsal_marker") {
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          if (!isSectionMarker(blocks[cursor])) continue;
          ids.add(blocks[cursor].id);
          break;
        }
      }
    }
  }
  return ids;
}

function segmentHasRehearsal(blocks: Block[], boundaryIndex: number): boolean {
  for (let index = boundaryIndex + 1; index < blocks.length; index++) {
    if (isSectionMarker(blocks[index])) return false;
    if (blocks[index].type === "rehearsal_marker") return true;
  }
  return false;
}

function indexesById(blocks: Block[]): Map<string, number> {
  const indexes = new Map<string, number>();
  for (let index = 0; index < blocks.length; index++) indexes.set(blocks[index].id, index);
  return indexes;
}

function shiftedPositions(positions: Set<number>, insertIndex: number): Set<number> {
  return new Set([...positions].map((position) => position >= insertIndex ? position + 1 : position));
}

function withInsertionsAfter(blocks: Block[], insertions: ReadonlyMap<number, Block>): Block[] {
  const next: Block[] = [];
  for (let index = 0; index < blocks.length; index++) {
    next.push(blocks[index]);
    const insertion = insertions.get(index);
    if (insertion) next.push(insertion);
  }
  return next;
}

function repairMarkerStructure(
  source: Block[],
  initialPositions: number[],
  fullScope: boolean,
  createId: IdFactory,
): Block[] {
  let blocks = source.slice();
  let positions = new Set(initialPositions);

  for (;;) {
    if (fullScope) positions = new Set(blocks.map((_, index) => index));
    let changed = false;
    const sectionIds = affectedSectionIds(blocks, positions);
    const sectionIndexById = indexesById(blocks);
    const sectionIndexes = [...sectionIds]
      .map((id) => sectionIndexById.get(id) ?? -1)
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    let insertedBefore = 0;
    if (fullScope) {
      const insertions = new Map<number, Block>();
      for (const index of sectionIndexes) {
        if (!segmentHasRehearsal(blocks, index) || blocks[index + 1]?.type === "rehearsal_marker") continue;
        insertions.set(index, makeRehearsalMarker(createId()));
      }
      if (insertions.size > 0) {
        blocks = withInsertionsAfter(blocks, insertions);
        changed = true;
      }
    } else {
      for (const originalIndex of sectionIndexes) {
        const index = originalIndex + insertedBefore;
        if (!segmentHasRehearsal(blocks, index) || blocks[index + 1]?.type === "rehearsal_marker") continue;
        blocks.splice(index + 1, 0, makeRehearsalMarker(createId()));
        positions = shiftedPositions(positions, index + 1);
        positions.add(index + 1);
        insertedBefore++;
        changed = true;
      }
    }

    const checksOpeningBlock = fullScope || positions.has(0) || positions.has(1);
    if (checksOpeningBlock && blocks[0]?.type !== "chapter_marker") {
      const id = createId();
      blocks.unshift(makeSectionMarker(id, "chapter", FIXED_INITIAL_CHAPTER_NAME, null));
      if (!fullScope) positions = shiftedPositions(positions, 0);
      positions.add(0);
      changed = true;
    }

    const chapterIds = new Set<string>();
    const blockIndexById = indexesById(blocks);
    const chapterIdAtIndex: Array<string | null> = [];
    let currentChapterId: string | null = null;
    for (let index = 0; index < blocks.length; index++) {
      if (blocks[index].type === "chapter_marker") currentChapterId = blocks[index].id;
      chapterIdAtIndex.push(currentChapterId);
    }
    for (const id of affectedSectionIds(blocks, positions)) {
      const index = blockIndexById.get(id);
      const chapterId = index === undefined ? null : chapterIdAtIndex[index];
      if (chapterId) chapterIds.add(chapterId);
    }
    const chapterIndexes = [...chapterIds]
      .map((id) => blockIndexById.get(id) ?? -1)
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    insertedBefore = 0;
    const firstSceneInsertions = new Map<number, Block>();
    for (const originalChapterIndex of chapterIndexes) {
      const chapterIndex = fullScope ? originalChapterIndex : originalChapterIndex + insertedBefore;
      let firstSceneIndex = -1;
      let hasTextBeforeScene = false;
      for (let index = chapterIndex + 1; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.type === "chapter_marker") break;
        if (firstSceneIndex < 0) {
          if (block.type === "scene_marker") firstSceneIndex = index;
          else if (!isMarkerBlock(block)) hasTextBeforeScene = true;
        }
      }
      if (firstSceneIndex <= chapterIndex + 1 || !hasTextBeforeScene) continue;
      const marker = makeSectionMarker(createId(), "scene", "", blocks[chapterIndex].id);
      if (fullScope) firstSceneInsertions.set(chapterIndex, marker);
      else {
        blocks.splice(chapterIndex + 1, 0, marker);
        positions = shiftedPositions(positions, chapterIndex + 1);
        positions.add(chapterIndex + 1);
        insertedBefore++;
      }
      changed = true;
    }
    if (firstSceneInsertions.size > 0) blocks = withInsertionsAfter(blocks, firstSceneInsertions);

    const openingMarkerId = blocks.find((block) => block.type === "chapter_marker")?.id ?? null;
    const markerIds = new Set<string>();
    for (const position of positions) {
      for (let index = Math.max(0, position - 1); index <= Math.min(blocks.length - 1, position + 1); index++) {
        if (isMarkerBlock(blocks[index])) markerIds.add(blocks[index].id);
      }
    }
    const markerIndexById = indexesById(blocks);
    const markerIndexes = [...markerIds]
      .map((id) => markerIndexById.get(id) ?? -1)
      .filter((index) => index >= 0)
      .sort((a, b) => b - a);
    const emptyInsertions = new Map<number, Block>();
    for (const index of markerIndexes) {
      const marker = blocks[index];
      let openingHasScene = false;
      if (marker.id === openingMarkerId && marker.type === "chapter_marker") {
        for (let cursor = index + 1; cursor < blocks.length; cursor++) {
          if (blocks[cursor].type === "chapter_marker") break;
          if (blocks[cursor].type === "scene_marker") { openingHasScene = true; break; }
        }
      }
      const openingWithoutScene = marker.id === openingMarkerId && marker.type === "chapter_marker" && !openingHasScene;
      if (openingWithoutScene || !(shouldInsertEmptyBlockAfterMarker(blocks, index) || index === blocks.length - 1)) continue;
      const emptyBlock = makeTextBlock(createId());
      if (fullScope) emptyInsertions.set(index, emptyBlock);
      else {
        blocks.splice(index + 1, 0, emptyBlock);
        positions = shiftedPositions(positions, index + 1);
        positions.add(index + 1);
      }
      changed = true;
    }
    if (emptyInsertions.size > 0) blocks = withInsertionsAfter(blocks, emptyInsertions);

    if (!changed) return blocks;
  }
}

type BlockRange = { start: number; end: number };

function markerTypeRank(type: BlockType | null): number | null {
  if (type === "chapter_marker") return 0;
  if (type === "scene_marker") return 1;
  if (type === "rehearsal_marker") return 2;
  return null;
}

function markerImpactType(change: BlockChange): BlockType | null {
  const beforeRank = markerTypeRank(change.beforeType);
  const afterRank = markerTypeRank(change.afterType);
  if (beforeRank === null) return afterRank === null ? null : change.afterType;
  if (afterRank === null) return change.beforeType;
  return beforeRank <= afterRank ? change.beforeType : change.afterType;
}

function mergeRanges(ranges: BlockRange[]): BlockRange[] {
  const sorted = ranges
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: BlockRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function hierarchyRanges(blocks: Block[], changes: BlockChange[]): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (const change of changes) {
    const impactType = markerImpactType(change);
    if (!impactType) continue;
    const start = Math.max(0, Math.min(blocks.length, change.position));
    const changedMarkerIsPresent = blocks[start]?.id === change.blockId && isMarkerBlock(blocks[start]);
    if (impactType === "rehearsal_marker") {
      if (changedMarkerIsPresent) ranges.push({ start, end: start + 1 });
      continue;
    }
    let end = blocks.length;
    for (let index = changedMarkerIsPresent ? start + 1 : start; index < blocks.length; index++) {
      const type = blocks[index].type;
      if (
        type === "chapter_marker" ||
        impactType === "scene_marker" && type === "scene_marker"
      ) {
        end = index;
        break;
      }
    }
    ranges.push({ start, end });
  }
  return mergeRanges(ranges);
}

export function markerHierarchyUpdateBlockIds(blocks: Block[], change: MarkerChange): string[] {
  const ids = new Set<string>();
  for (const range of hierarchyRanges(blocks, change.changes)) {
    for (let index = range.start; index < range.end; index++) {
      if (isMarkerBlock(blocks[index])) ids.add(blocks[index].id);
    }
  }
  return [...ids];
}

function updateMarkerHierarchy(
  blocks: Block[],
  changes: BlockChange[] | "full",
): { blocks: Block[]; changed: boolean } {
  const ranges = changes === "full" ? [{ start: 0, end: blocks.length }] : hierarchyRanges(blocks, changes);
  if (ranges.length === 0) return { blocks, changed: false };

  const chapterBefore: Array<string | null> = [];
  const sectionBefore: Array<string | null> = [];
  let chapterId: string | null = null;
  let sectionId: string | null = null;
  for (const block of blocks) {
    chapterBefore.push(chapterId);
    sectionBefore.push(sectionId);
    if (block.type === "chapter_marker") {
      chapterId = block.id;
      sectionId = block.id;
    } else if (block.type === "scene_marker") {
      sectionId = block.id;
    }
  }

  const next = blocks.slice();
  let changed = false;
  for (const range of ranges) {
    chapterId = chapterBefore[range.start] ?? null;
    sectionId = sectionBefore[range.start] ?? null;
    for (let index = range.start; index < range.end; index++) {
      const block = next[index];
      let parentMarkerId: string | null | undefined;
      let sceneId = block.sceneId;
      if (block.type === "chapter_marker") {
        parentMarkerId = null;
        sceneId = block.id;
        chapterId = block.id;
        sectionId = block.id;
      } else if (block.type === "scene_marker") {
        parentMarkerId = chapterId;
        sceneId = block.id;
        sectionId = block.id;
      } else if (block.type === "rehearsal_marker") {
        parentMarkerId = sectionId;
      } else {
        continue;
      }
      if (
        block.markerMeta?.parentMarkerId === parentMarkerId &&
        block.sceneId === sceneId &&
        !("ownerMarkerId" in block)
      ) continue;
      const marker = { ...block, sceneId, markerMeta: { ...block.markerMeta, parentMarkerId } };
      delete marker.ownerMarkerId;
      next[index] = marker;
      changed = true;
    }
  }
  return { blocks: changed ? next : blocks, changed };
}

function ownershipRanges(blocks: Block[], changes: BlockChange[]): MarkerOwnershipRange[] {
  const ranges: MarkerOwnershipRange[] = [];
  for (const change of changes) {
    const impactType = markerImpactType(change);
    const position = Math.max(0, Math.min(blocks.length, change.position));
    if (impactType) {
      if (change.kind === "structure") continue;
      if (blocks[position] && blocks[position].id !== change.blockId && isMarkerBlock(blocks[position])) continue;
      ranges.push({ start: position, end: Math.min(blocks.length, position + 1), throughNextMarker: true });
    } else if (
      change.afterType &&
      (change.kind === "insert" || change.kind === "move-target")
    ) {
      ranges.push({ start: position, end: Math.min(blocks.length, position + 1), throughNextMarker: false });
    }
  }
  return ranges;
}

export function markerCacheUpdateBlockIds(blocks: Block[], change: MarkerChange): string[] {
  const ids = new Set(markerHierarchyUpdateBlockIds(blocks, change));
  for (const id of change.ownershipBlockIds ?? []) ids.add(id);
  for (const range of ownershipRanges(blocks, change.changes)) {
    let end = range.end;
    if (range.throughNextMarker !== false) {
      for (let index = range.end; index < blocks.length; index++) {
        if (isMarkerBlock(blocks[index])) break;
        end = index + 1;
      }
    }
    for (let index = range.start; index < end; index++) ids.add(blocks[index].id);
  }
  return [...ids];
}

function projectFinalScenes(blocks: Block[], previous: Scene[]): Scene[] {
  const projected = projectMarkers({ blocks, scenes: previous }, previous)
    .map(({ id, number, name, parentId }) => ({ id, number, name, parentId }));
  const previousById = new Map(previous.map((scene) => [scene.id, scene]));
  return projected.map((scene) => {
    const before = previousById.get(scene.id);
    return before &&
      before.number === scene.number &&
      before.name === scene.name &&
      before.parentId === scene.parentId
      ? before
      : scene;
  });
}

function normalizeMarkerStateRules(
  state: ScriptState,
  change: MarkerChange | "full",
  createId: IdFactory,
): ScriptState {
  const fullScope = change === "full";
  const originalChanges = fullScope ? [] : change.changes;
  let blocks = repairMarkerStructure(state.blocks, fullScope ? [] : change.positions, fullScope, createId);
  const originalBlockIds = new Set(state.blocks.map((block) => block.id));
  const repairChanges: BlockChange[] = blocks.flatMap((block, position) =>
    originalBlockIds.has(block.id) ? [] : [{
      kind: "insert",
      position,
      blockId: block.id,
      beforeType: null,
      afterType: block.type,
    }]);
  const repairInsertionPositions = repairChanges
    .map((repairChange) => repairChange.position)
    .sort((a, b) => a - b);
  const finalIndexById = indexesById(blocks);
  const rebasedChanges = originalChanges.map((originalChange) => {
    if (
      originalChange.kind !== "delete" &&
      originalChange.kind !== "move-source"
    ) {
      const position = finalIndexById.get(originalChange.blockId);
      if (position !== undefined) return { ...originalChange, position };
    }
    let position = originalChange.position;
    for (const insertionPosition of repairInsertionPositions) {
      if (insertionPosition <= position) position++;
    }
    return position === originalChange.position ? originalChange : { ...originalChange, position };
  });
  const structuralChanges = [...rebasedChanges, ...repairChanges];

  const hierarchy = updateMarkerHierarchy(blocks, fullScope ? "full" : structuralChanges);
  blocks = hierarchy.blocks;
  if (fullScope) {
    blocks = withMarkerOwnership(blocks);
  } else {
    blocks = updateMarkerOwnership(blocks, ownershipRanges(blocks, structuralChanges));
  }

  const markerStructureChanged = fullScope ||
    (!fullScope && change.markerStructureChanged) ||
    repairChanges.some((repairChange) => markerImpactType(repairChange) !== null) ||
    hierarchy.changed;
  const scenes = markerStructureChanged ? projectFinalScenes(blocks, state.scenes) : state.scenes;
  const openingMarkerId = markerStructureChanged
    ? blocks.find((block) => block.type === "chapter_marker")?.id ?? null
    : state.config.openingChapterMarkerId;
  return {
    ...state,
    blocks,
    scenes,
    config: { ...state.config, openingChapterMarkerId: openingMarkerId },
  };
}

export function normalizeScriptMarkerInvariants(
  state: ScriptState,
  createId: IdFactory,
  scope: MarkerNormalizationScope = { mode: "full" },
): ScriptState {
  if (scope.mode === "scoped" && scope.positions.length === 0) return state;
  const normalized = normalizeMarkerStateRules(state, scope.mode === "full" ? "full" : scope, createId);
  if (scope.mode === "full") return normalized;

  const blocks = normalized.blocks;
  const scenes = normalized.scenes === state.scenes
    ? state.scenes
    : (() => {
        const previousSceneById = new Map(state.scenes.map((scene) => [scene.id, scene]));
        return normalized.scenes.map((scene) => {
          const previous = previousSceneById.get(scene.id);
          return previous &&
            previous.number === scene.number &&
            previous.name === scene.name &&
            previous.parentId === scene.parentId
            ? previous
            : scene;
        });
      })();
  const config = normalized.config.openingChapterMarkerId === state.config.openingChapterMarkerId
    ? state.config
    : normalized.config;
  if (
    blocks.length === state.blocks.length &&
    blocks.every((block, index) => block === state.blocks[index]) &&
    scenes.length === state.scenes.length &&
    scenes.every((scene, index) => scene === state.scenes[index]) &&
    config === state.config
  ) return state;
  return { ...normalized, blocks, scenes, config };
}

export function normalizeMarkerStateAfterEdit(
  previous: ScriptState,
  edited: ScriptState,
  createId: IdFactory,
): ScriptState {
  const change = getMarkerChange(previous.blocks, edited.blocks);
  if (change.positions.length === 0) return edited;
  let currentChapterId: string | null = null;
  let currentParentMarkerId: string | null = null;
  let currentOwnerMarkerId: string | null = null;
  for (const block of previous.blocks) {
    if (block.type === "chapter_marker") {
      if (block.markerMeta?.parentMarkerId !== null || block.sceneId !== block.id) {
        return normalizeScriptMarkerInvariants(edited, createId);
      }
      currentChapterId = block.id;
      currentParentMarkerId = block.id;
      currentOwnerMarkerId = block.id;
    } else if (block.type === "scene_marker") {
      if (block.markerMeta?.parentMarkerId !== currentChapterId || block.sceneId !== block.id) {
        return normalizeScriptMarkerInvariants(edited, createId);
      }
      currentParentMarkerId = block.id;
      currentOwnerMarkerId = block.id;
    } else if (block.type === "rehearsal_marker") {
      if (block.markerMeta?.parentMarkerId !== currentParentMarkerId) return normalizeScriptMarkerInvariants(edited, createId);
      currentOwnerMarkerId = block.id;
    } else if (block.ownerMarkerId !== currentOwnerMarkerId) {
      return normalizeScriptMarkerInvariants(edited, createId);
    }
  }
  return normalizeScriptMarkerInvariants(edited, createId, {
    mode: "scoped",
    ...change,
  });
}

export function normalizeMarkerState(state: ScriptState, createId: IdFactory): ScriptState {
  return normalizeScriptMarkerInvariants(state, createId);
}

function markerIndex(state: ScriptState, id: string): number {
  const resolved = resolveMarkerId(state, id);
  return resolved ? state.blocks.findIndex((block) => block.id === resolved) : -1;
}

function deletableMarkerIndex(state: ScriptState, id: string): number {
  const exactIndex = state.blocks.findIndex((block) => isMarkerBlock(block) && block.id === id);
  return exactIndex >= 0
    ? exactIndex
    : state.blocks.findIndex((block) => isSectionMarker(block) && block.sceneId === id);
}

export function insertMarker(state: ScriptState, input: MarkerInsert, createId: IdFactory): ScriptState {
  const blocks = [...state.blocks];
  const beforeIndex = input.beforeId ? markerIndex(state, input.beforeId) : -1;
  const afterIndex = input.afterId ? markerIndex(state, input.afterId) : -1;
  const beforeBlockIndex = input.beforeBlockId ? blocks.findIndex((block) => block.id === input.beforeBlockId) : -1;
  const afterBlockIndex = input.afterBlockId ? blocks.findIndex((block) => block.id === input.afterBlockId) : -1;
  const afterMarker = afterIndex >= 0 ? blocks[afterIndex] : null;
  const afterMarkerIndex = afterMarker && (
    input.kind === "chapter" || afterMarker.type === "scene_marker"
  ) ? ownedRange(blocks, afterIndex).end : afterIndex + 1;
  let insertIndex = beforeIndex >= 0
    ? beforeIndex
    : afterIndex >= 0
      ? afterMarkerIndex
      : beforeBlockIndex >= 0
        ? beforeBlockIndex
        : afterBlockIndex >= 0
          ? afterBlockIndex + 1
          : blocks.length;
  let parentId = input.kind === "scene" && input.parentId ? resolveMarkerId(state, input.parentId) : null;
  if (input.kind === "scene" && !parentId) {
    for (let index = insertIndex - 1; index >= 0; index--) {
      if (blocks[index].type === "chapter_marker") { parentId = blocks[index].id; break; }
    }
  }
  if (input.kind === "scene" && parentId && beforeIndex < 0 && afterIndex < 0 && beforeBlockIndex < 0 && afterBlockIndex < 0) {
    const parentIndex = blocks.findIndex((block) => block.id === parentId);
    const nextChapter = blocks.findIndex((block, index) => index > parentIndex && block.type === "chapter_marker");
    insertIndex = nextChapter < 0 ? blocks.length : nextChapter;
  }
  const id = createId();
  const firstChapterIndex = blocks.findIndex((block) => block.type === "chapter_marker");
  const isOpeningChapterInsert = input.kind === "chapter" && (firstChapterIndex < 0 || insertIndex <= firstChapterIndex);
  const requestedName = input.name?.trim() ?? "";
  const name = requestedName || (isOpeningChapterInsert ? FIXED_INITIAL_CHAPTER_NAME : "");
  blocks.splice(insertIndex, 0, makeSectionMarker(id, input.kind, name, parentId));
  if (isOpeningChapterInsert) blocks.splice(insertIndex + 1, 0, makeTextBlock(createId()));
  return normalizeMarkerStateAfterEdit(state, { ...state, blocks }, createId);
}

export function insertHierarchyMarker(state: ScriptState, input: MarkerInsert, createId: IdFactory): ScriptState {
  const parentId = input.kind === "scene" && input.parentId ? resolveMarkerId(state, input.parentId) : null;
  const parentIndex = parentId ? state.blocks.findIndex((block) => block.id === parentId && block.type === "chapter_marker") : -1;
  if (parentIndex >= 0) {
    const nextChapterIndex = state.blocks.findIndex((block, index) => index > parentIndex && block.type === "chapter_marker");
    const chapterEnd = nextChapterIndex < 0 ? state.blocks.length : nextChapterIndex;
    const hasScene = state.blocks.slice(parentIndex + 1, chapterEnd).some((block) => block.type === "scene_marker");
    if (!hasScene) {
      return insertMarker(state, {
        ...input,
        beforeId: null,
        afterId: null,
        beforeBlockId: null,
        afterBlockId: parentId,
      }, createId);
    }
  }
  return insertMarker(state, input, createId);
}

export function convertMarker(state: ScriptState, id: string, kind: MarkerKind, createId: IdFactory): ScriptState {
  const index = markerIndex(state, id);
  if (index < 0) return state;
  const selected = state.blocks[index];
  const currentKind: MarkerKind = selected.type === "chapter_marker" ? "chapter" : "scene";
  if (currentKind === kind) return state;
  const blocks = [...state.blocks];

  if (kind === "scene") {
    let precedingChapterId: string | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      if (blocks[cursor].type === "chapter_marker") { precedingChapterId = blocks[cursor].id; break; }
    }
    if (!precedingChapterId) {
      precedingChapterId = createId();
      blocks.splice(index, 0, makeSectionMarker(precedingChapterId, "chapter", FIXED_INITIAL_CHAPTER_NAME, null));
    }
    const selectedIndex = blocks.findIndex((block) => block.id === selected.id);
    blocks[selectedIndex] = { ...selected, type: "scene_marker", sceneId: selected.id, markerMeta: { ...selected.markerMeta, parentMarkerId: precedingChapterId } };
  } else {
    blocks[index] = { ...selected, type: "chapter_marker", sceneId: selected.id, markerMeta: { ...selected.markerMeta, parentMarkerId: null } };
  }
  return normalizeMarkerStateAfterEdit(state, { ...state, blocks }, createId);
}

function ownedRange(blocks: Block[], index: number): { end: number; blockIds: string[]; hasNonEmptyScript: boolean } {
  const markerRank = markerBlockRank(blocks[index])!;
  let end = blocks.length;
  for (let cursor = index + 1; cursor < blocks.length; cursor++) {
    const candidateRank = markerBlockRank(blocks[cursor]);
    if (candidateRank !== null && candidateRank <= markerRank) {
      end = cursor;
      break;
    }
  }
  const owned = blocks.slice(index + 1, end);
  return {
    end,
    blockIds: blocks.slice(index, end).map((block) => block.id),
    hasNonEmptyScript: owned.some((block) => !isMarkerBlock(block) && !isEmptyTextBlock(block)),
  };
}

export function planMarkerDeletion(
  state: ScriptState,
  id: string,
  detailRows: Array<Scene & Partial<MarkerDetailFields>> = [],
): MarkerDeletePlan {
  const index = deletableMarkerIndex(state, id);
  if (index < 0) return { status: "blocked", kind: "scene", message: "未找到章节或段落。" };
  const marker = state.blocks[index];
  const kind: MarkerKind = marker.type === "chapter_marker" ? "chapter" : "scene";
  const detailById = new Map(detailRows.map((detail) => [detail.id, detail]));
  const markerHasDetails = (block: Block) => {
    const detail = detailById.get(block.id) ?? (block.sceneId ? detailById.get(block.sceneId) : undefined);
    return hasDetails(block.markerMeta) || !!detail && [detail.synopsis, detail.actionLine, detail.music, detail.stageNotes, detail.expectedDuration]
      .some((value) => typeof value === "string" && value.trim() !== "");
  };
  if (markerHasDetails(marker)) {
    return { status: "blocked", kind, message: `该${kind === "chapter" ? "章节" : "段落"}包含构作详情，清空详情后才能删除。` };
  }
  const range = ownedRange(state.blocks, index);
  if (range.hasNonEmptyScript) {
    return { status: "ready", operation: { type: "marker-only", markerId: marker.id }, previewBlockIds: [marker.id] };
  }
  if (kind === "scene") {
    return { status: "ready", operation: { type: "whole", markerId: marker.id }, previewBlockIds: range.blockIds };
  }

  let hasChildren = false;
  for (let childIndex = index + 1; childIndex < range.end; childIndex++) {
    const child = state.blocks[childIndex];
    if (child.type !== "scene_marker") continue;
    hasChildren = true;
    if (markerHasDetails(child) || ownedRange(state.blocks, childIndex).hasNonEmptyScript) {
      return { status: "ready", operation: { type: "marker-only", markerId: marker.id }, previewBlockIds: [marker.id] };
    }
  }
  if (!hasChildren) {
    return { status: "ready", operation: { type: "whole", markerId: marker.id }, previewBlockIds: range.blockIds };
  }
  return {
    status: "choice",
    options: [
      { type: "marker-only", markerId: marker.id },
      { type: "whole", markerId: marker.id },
    ],
    previewBlockIds: range.blockIds,
  };
}

export function executeMarkerDeletion(state: ScriptState, operation: MarkerDeleteOperation, createId: IdFactory): ScriptState {
  const index = deletableMarkerIndex(state, operation.markerId);
  if (index < 0) return state;
  const range = ownedRange(state.blocks, index);
  const removeIds = operation.type === "marker-only"
    ? new Set([state.blocks[index].id])
    : new Set(range.blockIds);
  if (
    operation.type === "marker-only" &&
    index >= 2 &&
    isEmptyTextBlock(state.blocks[index - 1]) &&
    state.blocks[index - 2].type === "chapter_marker" &&
    state.blocks[index + 1]?.type === "scene_marker"
  ) {
    removeIds.add(state.blocks[index - 1].id);
  }
  const blocks = state.blocks.filter((block) => !removeIds.has(block.id));
  return normalizeMarkerStateAfterEdit(
    state,
    { ...state, blocks: blocks.length > 0 ? blocks : [makeTextBlock(createId())] },
    createId,
  );
}

export function updateMarkerMeta(state: ScriptState, id: string, fields: Partial<MarkerMeta>): ScriptState {
  const resolved = resolveMarkerId(state, id);
  if (!resolved) return state;
  const markerIndex = state.blocks.findIndex((block) => block.id === resolved);
  const marker = state.blocks[markerIndex];
  const nextFields = { ...fields };
  if (marker.type === "chapter_marker" && "expectedDuration" in nextFields) {
    for (let index = markerIndex + 1; index < state.blocks.length; index++) {
      if (state.blocks[index].type === "chapter_marker") break;
      if (state.blocks[index].type === "scene_marker") {
        delete nextFields.expectedDuration;
        break;
      }
    }
  }
  return {
    ...state,
    blocks: state.blocks.map((block) => block.id === resolved
      ? { ...block, markerMeta: { ...block.markerMeta, ...nextFields } }
      : block),
  };
}
