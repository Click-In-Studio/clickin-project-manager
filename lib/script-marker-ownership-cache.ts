import type { Block } from "./script-types";
import { toAlphaLabel } from "./script-generated-labels";
import { withMarkerOwnership } from "./script-marker-blocks";

export type MarkerOwnershipRange = {
  start: number;
  end: number;
  affectsMarkers?: boolean;
};

export type MarkerOwnershipDirty = "full" | MarkerOwnershipRange | MarkerOwnershipRange[] | null;

type OwnershipContext = {
  sceneId: string | null;
  rehearsalMark: string | null;
  rehearsalIndex: number;
};
type MarkerOwnership = Pick<Block, "sceneId" | "rehearsalMark">;

function sameOwnership(a: Block, b: Block): boolean {
  return a.sceneId === b.sceneId && a.rehearsalMark === b.rehearsalMark;
}

function withOwnership(block: Block, sceneId: string | null, rehearsalMark: string | null): Block {
  return block.sceneId === sceneId && block.rehearsalMark === rehearsalMark
    ? block
    : { ...block, sceneId, rehearsalMark };
}

function normalizeRanges(dirty: MarkerOwnershipDirty, length: number): MarkerOwnershipRange[] | null {
  if (!dirty || dirty === "full") return null;
  const ranges = Array.isArray(dirty) ? dirty : [dirty];
  const normalized = ranges
    .map((range) => ({
      ...range,
      start: Math.max(0, Math.min(length, range.start)),
      end: Math.max(0, Math.min(length, range.end)),
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);
  if (normalized.length === 0) return [];

  const merged: MarkerOwnershipRange[] = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      last.affectsMarkers = last.affectsMarkers || range.affectsMarkers;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function readContextBefore(blocks: Block[], index: number): OwnershipContext {
  let sceneId: string | null = null;
  let rehearsalMark: string | null = null;
  let rehearsalIndex = 0;
  let boundary = 0;

  for (let i = index - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === "chapter_marker" || block.type === "scene_marker") {
      sceneId = block.sceneId;
      boundary = i + 1;
      break;
    }
  }

  for (let i = boundary; i < index; i++) {
    const block = blocks[i];
    if (block.type === "rehearsal_marker") {
      rehearsalMark = toAlphaLabel(rehearsalIndex);
      rehearsalIndex += 1;
    }
  }

  return { sceneId, rehearsalMark, rehearsalIndex };
}

function findNextSceneBoundary(blocks: Block[], index: number): number {
  for (let i = index; i < blocks.length; i++) {
    const type = blocks[i].type;
    if (type === "chapter_marker" || type === "scene_marker") return i;
  }
  return blocks.length;
}

function applyRangeOwnership(target: Block[], blocks: Block[], start: number, end: number): void {
  let { sceneId, rehearsalMark, rehearsalIndex } = readContextBefore(blocks, start);

  for (let i = start; i < end; i++) {
    const block = blocks[i];
    if (block.type === "chapter_marker" || block.type === "scene_marker") {
      sceneId = block.sceneId;
      rehearsalMark = null;
      rehearsalIndex = 0;
      target[i] = block;
    } else if (block.type === "rehearsal_marker") {
      rehearsalMark = toAlphaLabel(rehearsalIndex);
      rehearsalIndex += 1;
      target[i] = withOwnership(block, block.sceneId, rehearsalMark);
    } else {
      target[i] = withOwnership(block, sceneId, rehearsalMark);
    }
  }
}

function updateNonMarkerRanges(prevOwned: Block[], nextBlocks: Block[], ranges: MarkerOwnershipRange[]): Block[] {
  const nextOwned = prevOwned.slice();
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) {
      const block = nextBlocks[i];
      const prev = prevOwned[i];
      nextOwned[i] = prev && prev.id === block.id && sameOwnership(prev, block)
        ? block
        : withOwnership(block, prev?.sceneId ?? block.sceneId, prev?.rehearsalMark ?? block.rehearsalMark);
    }
  }
  return nextOwned;
}

function carryPreviousOwnership(prevOwned: Block[], nextBlocks: Block[]): Block[] {
  const prevById = new Map(prevOwned.map((block) => [block.id, block]));
  return nextBlocks.map((block) => {
    const prev = prevById.get(block.id);
    return prev ? withOwnership(block, prev.sceneId, prev.rehearsalMark) : block;
  });
}

export function markerOwnershipRange(blocks: Block[], start: number, end: number): MarkerOwnership[] {
  const safeStart = Math.max(0, Math.min(blocks.length, start));
  const safeEnd = Math.max(safeStart, Math.min(blocks.length, end));
  let { sceneId, rehearsalMark, rehearsalIndex } = readContextBefore(blocks, safeStart);
  const ownership: MarkerOwnership[] = [];

  for (let i = safeStart; i < safeEnd; i++) {
    const block = blocks[i];
    if (block.type === "chapter_marker" || block.type === "scene_marker") {
      sceneId = block.sceneId;
      rehearsalMark = null;
      rehearsalIndex = 0;
      ownership.push({ sceneId, rehearsalMark });
    } else if (block.type === "rehearsal_marker") {
      rehearsalMark = toAlphaLabel(rehearsalIndex);
      rehearsalIndex += 1;
      ownership.push({ sceneId: block.sceneId, rehearsalMark });
    } else {
      ownership.push({ sceneId, rehearsalMark });
    }
  }

  return ownership;
}

export function updateMarkerOwnership(
  prevBlocks: Block[] | null,
  nextBlocks: Block[],
  prevOwned: Block[] | null,
  dirty: MarkerOwnershipDirty,
): Block[] {
  if (!prevBlocks || !prevOwned || dirty === "full" || prevOwned.length !== prevBlocks.length) {
    return withMarkerOwnership(nextBlocks);
  }

  const ranges = normalizeRanges(dirty, nextBlocks.length);
  if (!ranges) return withMarkerOwnership(nextBlocks);
  if (ranges.length === 0) return prevOwned.length === nextBlocks.length ? prevOwned : withMarkerOwnership(nextBlocks);

  const structureChanged = prevBlocks.length !== nextBlocks.length;
  const markerAffected = structureChanged || ranges.some((range) => range.affectsMarkers);

  if (!markerAffected && prevOwned.length === nextBlocks.length) {
    return updateNonMarkerRanges(prevOwned, nextBlocks, ranges);
  }

  const nextOwned = carryPreviousOwnership(prevOwned, nextBlocks);
  for (const range of ranges) {
    const start = Math.max(0, range.start);
    const end = findNextSceneBoundary(nextBlocks, Math.max(start + 1, range.end));
    applyRangeOwnership(nextOwned, nextBlocks, start, end);
  }
  return nextOwned;
}
