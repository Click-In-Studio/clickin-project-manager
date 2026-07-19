import type { Block } from "./script-types";
import { isMarkerBlock, withMarkerOwnership } from "./script-marker-blocks";

export type MarkerOwnershipRange = {
  start: number;
  end: number;
  throughNextMarker?: boolean;
};

export type MarkerOwnershipDirty = "full" | MarkerOwnershipRange | MarkerOwnershipRange[] | null;

function normalizeRanges(dirty: MarkerOwnershipDirty, length: number): MarkerOwnershipRange[] | null {
  if (dirty === "full") return null;
  if (!dirty) return [];
  const ranges = Array.isArray(dirty) ? dirty : [dirty];
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(length, range.start)),
      end: Math.max(0, Math.min(length, range.end)),
      throughNextMarker: range.throughNextMarker,
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);
  const merged: MarkerOwnershipRange[] = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end && last.throughNextMarker === range.throughNextMarker) {
      last.end = Math.max(last.end, range.end);
    } else merged.push({ ...range });
  }
  return merged;
}

function ownerBefore(blocks: Block[], index: number): string | null {
  const previous = blocks[index - 1];
  if (!previous) return null;
  if (isMarkerBlock(previous)) return previous.id;
  return previous.ownerMarkerId ?? null;
}

function findNextMarkerBoundary(blocks: Block[], index: number): number {
  for (let cursor = index; cursor < blocks.length; cursor++) {
    if (isMarkerBlock(blocks[cursor])) return cursor;
  }
  return blocks.length;
}

function applyRangeOwnership(target: Block[], blocks: Block[], start: number, end: number): void {
  let ownerMarkerId = ownerBefore(blocks, start);
  for (let index = start; index < end; index++) {
    const block = blocks[index];
    if (isMarkerBlock(block)) {
      ownerMarkerId = block.id;
      if ("ownerMarkerId" in block) {
        const marker = { ...block };
        delete marker.ownerMarkerId;
        target[index] = marker;
      }
    } else if (block.ownerMarkerId !== ownerMarkerId) {
      target[index] = { ...block, ownerMarkerId };
    }
  }
}

export function updateMarkerOwnership(
  blocks: Block[],
  dirty: MarkerOwnershipDirty,
): Block[] {
  const ranges = normalizeRanges(dirty, blocks.length);
  if (!ranges) return withMarkerOwnership(blocks);
  if (ranges.length === 0) return blocks;
  const next = blocks.slice();
  for (const range of ranges) {
    const end = range.throughNextMarker === false
      ? range.end
      : findNextMarkerBoundary(blocks, range.end);
    applyRangeOwnership(next, next, range.start, end);
  }
  return next;
}
