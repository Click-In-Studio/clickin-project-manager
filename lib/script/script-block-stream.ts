import { isTextBlock } from "@/lib/script/script-block-layout";
import { isMarkerBlock, withMarkerOwnership } from "@/lib/script/script-marker-blocks";
import { getMarkerChange, normalizeScriptMarkerInvariants as normalizeSharedMarkerInvariants, type BlockChange, type MarkerChange } from "@/lib/script/script-marker-domain";
import type { MarkerOwnershipDirty } from "@/lib/script/script-marker-ownership-cache";
import { sameSceneRows } from "@/lib/script/script-scene-details";
import { DEFAULT_SCRIPT_CONFIG, type Block, type BlockType, type Scene, type ScriptState, type ScriptConfig } from "@/lib/script/script-types";

let _seq = 0;
export const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36)}`;

export const makeBlock = (content = "", characterIds: string[] = [], type: BlockType = "dialogue"): Block => ({
  id: uid(),
  type,
  content,
  characterIds,
  characterAnnotations: {},
  lyric: false,
  sceneId: null,
  rehearsalMark: null,
  forceShowCharacterName: false,
});


export const makeMarkerBlock = (
  type: Extract<BlockType, "chapter_marker" | "scene_marker" | "rehearsal_marker">,
  fields: Pick<Partial<Block>, "sceneId"> = {}
): Block => ({
  ...makeBlock("", [], type),
  sceneId: fields.sceneId ?? null,
});

export const isBlockEmptyForDelete = (block: Block) =>
  block.content.trim() === "" &&
  !(block.stageComment ?? "").trim() &&
  block.characterIds.length === 0 &&
  Object.values(block.characterAnnotations).every((ann) => ann.trim() === "");

export const isEmptyTextBlock = (block: Block) => isTextBlock(block) && isBlockEmptyForDelete(block);

export function mergeServerBlocks(
  local: Block[],
  serverBlocks: Block[],
  synced: ScriptState | null
): Block[] {
  const syncedMap = new Map((synced?.blocks ?? []).map(b => [b.id, b]));
  const localMap = new Map(local.map(b => [b.id, b]));
  const projectedLocalMap = new Map(normalizeScriptBlockStream(local).map(b => [b.id, b]));
  const syncedBlocks = synced?.blocks ?? [];
  const localOrderDirty = !!synced && (
    local.length !== syncedBlocks.length ||
    local.some((b, i) => b.id !== syncedBlocks[i]?.id)
  );

  const isDirty = (b: Block): boolean => {
    const s = syncedMap.get(b.id);
    if (!s) return true;
    const projected = projectedLocalMap.get(b.id) ?? b;
    return (
      projected.content !== s.content ||
      (projected.stageComment ?? "") !== (s.stageComment ?? "") ||
      projected.type !== s.type ||
      projected.lyric !== s.lyric ||
      (projected.forceShowCharacterName ?? false) !== (s.forceShowCharacterName ?? false) ||
      projected.rehearsalMark !== s.rehearsalMark ||
      projected.sceneId !== s.sceneId ||
      projected.characterIds.length !== s.characterIds.length ||
      projected.characterIds.some((id, i) => id !== s.characterIds[i]) ||
      projected.characterIds.some((id) => (projected.characterAnnotations[id] ?? "") !== (s.characterAnnotations[id] ?? ""))
    );
  };

  if (localOrderDirty) {
    const serverMap = new Map(serverBlocks.map(b => [b.id, b]));
    const result = local.map(lb => {
      const sb = serverMap.get(lb.id);
      return isDirty(lb) ? lb : (sb ?? lb);
    });
    for (const sb of serverBlocks) {
      if (!localMap.has(sb.id)) result.push(sb);
    }
    return result;
  }

  // Server ordering is authoritative when local ordering has no unsynced edits.
  const result: Block[] = serverBlocks.map(sb => {
    const loc = localMap.get(sb.id);
    return loc && isDirty(loc) ? loc : sb;
  });

  // Keep locally-new blocks not yet on server
  const serverIds = new Set(serverBlocks.map(b => b.id));
  for (const loc of local) {
    if (!serverIds.has(loc.id) && isDirty(loc)) result.push(loc);
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function stripHtmlText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}






export function expandLegacyMarkersToBlocks(blocks: Block[], scenes: Scene[] = []): Block[] {
  if (blocks.some(isMarkerBlock)) {
    return normalizeScriptBlockStream(blocks);
  }

  let changed = false;
  let previousSceneId: string | null = null;
  let previousRehearsalMark: string | null = null;
  let lastChapterId: string | null = null;
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const next: Block[] = [];

  for (const block of blocks) {
    const sceneChanged = block.sceneId !== previousSceneId;
    if (sceneChanged && block.sceneId) {
      const scene = sceneById.get(block.sceneId) ?? null;
      if (scene?.parentId) {
        if (scene.parentId !== lastChapterId) {
          next.push(makeMarkerBlock("chapter_marker", { sceneId: scene.parentId }));
          lastChapterId = scene.parentId;
        }
        next.push(makeMarkerBlock("scene_marker", { sceneId: scene.id }));
      } else {
        next.push(makeMarkerBlock("chapter_marker", { sceneId: block.sceneId }));
        lastChapterId = block.sceneId;
      }
      changed = true;
      previousRehearsalMark = null;
    }

    if (block.rehearsalMark && block.rehearsalMark !== previousRehearsalMark) {
      next.push(makeMarkerBlock("rehearsal_marker"));
      changed = true;
    }

    previousSceneId = block.sceneId;
    previousRehearsalMark = block.rehearsalMark;
    if (block.sceneId || block.rehearsalMark) {
      changed = true;
      next.push({ ...block, sceneId: null, rehearsalMark: null });
    } else {
      next.push(block);
    }
  }

  return changed ? normalizeScriptBlockStream(next) : blocks;
}

export function normalizeScriptBlockStream(blocks: Block[]): Block[] {
  return withMarkerOwnership(blocks);
}

export function sameBlocks(a: Block[], b: Block[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index];
    return !!other &&
      block.id === other.id &&
      block.type === other.type &&
      block.content === other.content &&
      (block.stageComment ?? null) === (other.stageComment ?? null) &&
      (block.forceShowCharacterName ?? false) === (other.forceShowCharacterName ?? false) &&
      block.lyric === other.lyric &&
      block.sceneId === other.sceneId &&
      block.rehearsalMark === other.rehearsalMark &&
      sameMarkerMeta(block.markerMeta, other.markerMeta) &&
      block.characterIds.length === other.characterIds.length &&
      block.characterIds.every((id, charIndex) => id === other.characterIds[charIndex]) &&
      sameCharacterAnnotations(block.characterAnnotations, other.characterAnnotations);
  });
}

export function sameMarkerMeta(a: Block["markerMeta"], b: Block["markerMeta"]): boolean {
  const aMeta = a ?? {};
  const bMeta = b ?? {};
  return (aMeta.name ?? undefined) === (bMeta.name ?? undefined) &&
    (aMeta.parentMarkerId ?? undefined) === (bMeta.parentMarkerId ?? undefined) &&
    (aMeta.synopsis ?? undefined) === (bMeta.synopsis ?? undefined) &&
    (aMeta.actionLine ?? undefined) === (bMeta.actionLine ?? undefined) &&
    (aMeta.music ?? undefined) === (bMeta.music ?? undefined) &&
    (aMeta.stageNotes ?? undefined) === (bMeta.stageNotes ?? undefined) &&
    (aMeta.expectedDuration ?? undefined) === (bMeta.expectedDuration ?? undefined);
}

export function sameCharacterAnnotations(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export function markerSegmentIsOpeningWithoutScene(blocks: Block[], markerIndex: number, openingChapterMarkerId: string | null): boolean {
  const marker = blocks[markerIndex];
  return !!openingChapterMarkerId && marker?.id === openingChapterMarkerId && !markerSegmentHasScene(blocks, markerIndex);
}

export function normalizeScriptMarkerInvariants(
  blocks: Block[],
  scenes: Scene[],
  config: ScriptConfig,
  change?: ReturnType<typeof getMarkerChange>,
): { blocks: Block[]; scenes: Scene[]; config: ScriptConfig } {
  const normalized = normalizeSharedMarkerInvariants({
    blocks,
    scenes,
    characters: [],
    config,
  }, uid, change ? { mode: "scoped", ...change } : { mode: "full" });
  return {
    blocks: sameBlocks(normalized.blocks, blocks) ? blocks : normalized.blocks,
    scenes: sameSceneRows(normalized.scenes, scenes) ? scenes : normalized.scenes,
    config: normalized.config.openingChapterMarkerId === config.openingChapterMarkerId ? config : normalized.config,
  };
}

export function previousAdjacentMarker(blocks: Block[], index: number): Block | null {
  const block = blocks[index - 1];
  return block && isMarkerBlock(block) ? block : null;
}

export function markerSegmentHasScene(blocks: Block[], markerIndex: number): boolean {
  for (let index = markerIndex + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === "chapter_marker") return false;
    if (block.type === "scene_marker") return true;
  }
  return false;
}

export function insertMarkerWithEmptyBlockIfNeeded(blocks: Block[], marker: Block, insertIndex: number, openingChapterMarkerId: string | null): Block[] {
  const next = [...blocks];
  const boundedIndex = Math.max(0, Math.min(next.length, insertIndex));
  const previousMarker = previousAdjacentMarker(blocks, boundedIndex);
  next.splice(boundedIndex, 0, marker);
  return repairEmptyMarkerSegments(
    next,
    [previousMarker?.id, marker.id].filter((id): id is string => !!id),
    openingChapterMarkerId,
  );
}

export function repairEmptyMarkerSegments(
  blocks: Block[],
  markerIds: Iterable<string>,
  openingChapterMarkerId: string | null,
): Block[] {
  const ids = [...new Set(markerIds)];
  if (ids.length === 0) return blocks;
  const positions = ids
    .map((id) => blocks.findIndex((block) => block.id === id))
    .filter((index) => index >= 0);
  const changes = positions.map((position) => ({
    kind: "structure" as const,
    position,
    blockId: blocks[position].id,
    beforeType: blocks[position].type,
    afterType: blocks[position].type,
  }));
  return normalizeSharedMarkerInvariants({
    blocks,
    scenes: [],
    characters: [],
    config: { ...DEFAULT_SCRIPT_CONFIG, openingChapterMarkerId },
  }, uid, { mode: "scoped", changes, positions, markerStructureChanged: true }).blocks;
}

export function findTocSceneBlockIndex(sceneId: string, scenes: Scene[], blocks: Block[]): number {
  const directIdx = blocks.findIndex((block) => block.sceneId === sceneId);
  if (directIdx >= 0) return directIdx;

  const scene = scenes.find((row) => row.id === sceneId);
  if (!scene || scene.parentId !== null) return -1;
  const childSceneIds = new Set(scenes.filter((row) => row.parentId === scene.id).map((row) => row.id));
  return blocks.findIndex((block) => !!block.sceneId && childSceneIds.has(block.sceneId));
}

export function findSceneMarkerBlockIndex(sceneId: string, blocks: Block[]): number {
  return blocks.findIndex((block) => (
    (block.type === "chapter_marker" || block.type === "scene_marker") &&
    block.sceneId === sceneId
  ));
}

export function mergeDirtyRanges(
  current: MarkerOwnershipDirty,
  dirty: Exclude<MarkerOwnershipDirty, null>,
): Exclude<MarkerOwnershipDirty, null> {
  if (current === "full" || dirty === "full") return "full";
  const currentRanges = current ? (Array.isArray(current) ? current : [current]) : [];
  const nextRanges = Array.isArray(dirty) ? dirty : [dirty];
  return [...currentRanges, ...nextRanges];
}

export function markerChangeFromOperations(changes: BlockChange[]): MarkerChange {
  const markerType = (type: BlockType | null) =>
    type === "chapter_marker" || type === "scene_marker" || type === "rehearsal_marker";
  return {
    changes,
    positions: [...new Set(changes.map((change) => change.position))].sort((a, b) => a - b),
    markerStructureChanged: changes.some((change) => markerType(change.beforeType) || markerType(change.afterType)),
  };
}
