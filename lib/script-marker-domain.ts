import { buildMarkerLabelIndex, type MarkerLabelIndex } from "./script-generated-labels";
import { isMarkerBlock, shouldInsertEmptyBlockAfterMarker, withMarkerOwnership } from "./script-marker-blocks";
import { FIXED_INITIAL_CHAPTER_NAME } from "./script-fixed-markers";
import type { Block, MarkerMeta, Scene, ScriptState } from "./script-types";

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

function repairEmptySegments(blocks: Block[], openingMarkerId: string | null, createId: IdFactory): Block[] {
  const next = [...blocks];
  for (let index = next.length - 1; index >= 0; index--) {
    const marker = next[index];
    if (!isMarkerBlock(marker)) continue;
    let openingHasScene = false;
    if (marker.id === openingMarkerId && marker.type === "chapter_marker") {
      for (let cursor = index + 1; cursor < next.length; cursor++) {
        if (next[cursor].type === "chapter_marker") break;
        if (next[cursor].type === "scene_marker") { openingHasScene = true; break; }
      }
    }
    const openingWithoutScene = marker.id === openingMarkerId && marker.type === "chapter_marker" && !openingHasScene;
    if (!openingWithoutScene && (shouldInsertEmptyBlockAfterMarker(next, index) || index === next.length - 1)) {
      next.splice(index + 1, 0, makeTextBlock(createId()));
    }
  }
  return next;
}

export function normalizeMarkerState(state: ScriptState, createId: IdFactory): ScriptState {
  let blocks: Block[] = state.blocks.map((block) => ({
    ...block,
    ...(block.markerMeta ? { markerMeta: { ...block.markerMeta } } : {}),
  }));
  let openingMarkerId = blocks.find((block) => block.type === "chapter_marker")?.id ?? null;
  if (blocks[0]?.type !== "chapter_marker") {
    const id = createId();
    blocks.unshift(makeSectionMarker(id, "chapter", FIXED_INITIAL_CHAPTER_NAME, null));
    openingMarkerId = id;
  }

  let currentChapterId: string | null = null;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === "chapter_marker") {
      currentChapterId = block.id;
      blocks[index] = { ...block, sceneId: block.id, markerMeta: { ...block.markerMeta, parentMarkerId: null } };
      continue;
    }
    if (block.type === "scene_marker") {
      if (!currentChapterId) continue;
      blocks[index] = { ...block, sceneId: block.id, markerMeta: { ...block.markerMeta, parentMarkerId: currentChapterId } };
    }
  }

  for (let chapterIndex = 0; chapterIndex < blocks.length;) {
    if (blocks[chapterIndex].type !== "chapter_marker") {
      chapterIndex++;
      continue;
    }
    let nextChapterIndex = blocks.length;
    let firstSceneIndex = -1;
    let hasTextBeforeScene = false;
    for (let index = chapterIndex + 1; index < blocks.length; index++) {
      const block = blocks[index];
      if (block.type === "chapter_marker") {
        nextChapterIndex = index;
        break;
      }
      if (firstSceneIndex < 0) {
        if (block.type === "scene_marker") firstSceneIndex = index;
        else if (!isMarkerBlock(block)) hasTextBeforeScene = true;
      }
    }
    const needsFirstScene = firstSceneIndex > chapterIndex + 1 && hasTextBeforeScene;
    if (needsFirstScene) {
      const id = createId();
      blocks.splice(chapterIndex + 1, 0, makeSectionMarker(id, "scene", "", blocks[chapterIndex].id));
    }
    chapterIndex = nextChapterIndex + (needsFirstScene ? 1 : 0);
  }

  blocks = repairEmptySegments(blocks, openingMarkerId, createId);
  blocks = withMarkerOwnership(blocks);
  const projection = projectMarkers({ blocks, scenes: state.scenes }, state.scenes);
  const scenes = projection.map(({ id, number, name, parentId }) => ({ id, number, name, parentId }));
  return {
    ...state,
    blocks,
    scenes,
    config: { ...state.config, openingChapterMarkerId: openingMarkerId },
  };
}

function markerIndex(state: ScriptState, id: string): number {
  const resolved = resolveMarkerId(state, id);
  return resolved ? state.blocks.findIndex((block) => block.id === resolved) : -1;
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
  return normalizeMarkerState({ ...state, blocks }, createId);
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
  return normalizeMarkerState({ ...state, blocks }, createId);
}

function ownedRange(blocks: Block[], index: number): { end: number; blockIds: string[]; hasNonEmptyScript: boolean } {
  const marker = blocks[index];
  let end = blocks.length;
  for (let cursor = index + 1; cursor < blocks.length; cursor++) {
    const candidate = blocks[cursor];
    if (marker.type === "scene_marker" ? isSectionMarker(candidate) : candidate.type === "chapter_marker") {
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
  const index = markerIndex(state, id);
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
  const index = markerIndex(state, operation.markerId);
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
  return normalizeMarkerState({ ...state, blocks: blocks.length > 0 ? blocks : [makeTextBlock(createId())] }, createId);
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
