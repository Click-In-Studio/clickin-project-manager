import type { Block } from "./script-types";

type MarkerContext = {
  chapterId: string;
  sceneId: string;
  rehearsalId: string | null;
};

export function isMarkerBlock(block: Block): boolean {
  return block.type === "chapter_marker" || block.type === "scene_marker" || block.type === "rehearsal_marker";
}

export function markerBlockRank(block: Block): number | null {
  if (block.type === "chapter_marker") return 0;
  if (block.type === "scene_marker") return 1;
  if (block.type === "rehearsal_marker") return 2;
  return null;
}

export function shouldInsertEmptyBlockAfterMarker(blocks: Block[], markerIndex: number): boolean {
  const marker = blocks[markerIndex];
  const next = blocks[markerIndex + 1];
  const markerRank = marker ? markerBlockRank(marker) : null;
  const nextRank = next ? markerBlockRank(next) : null;
  return markerRank !== null && nextRank !== null && nextRank <= markerRank;
}

export function buildMarkerContextById(
  blocks: Array<Pick<Block, "id" | "type" | "markerMeta">>,
): ReadonlyMap<string, MarkerContext> {
  const markerContextById = new Map<string, MarkerContext>();

  for (const block of blocks) {
    if (block.type === "chapter_marker") {
      markerContextById.set(block.id, { chapterId: block.id, sceneId: block.id, rehearsalId: null });
    } else if (block.type === "scene_marker") {
      markerContextById.set(block.id, { chapterId: block.markerMeta?.parentMarkerId ?? block.id, sceneId: block.id, rehearsalId: null });
    } else if (block.type === "rehearsal_marker") {
      const parentId = block.markerMeta?.parentMarkerId;
      const parent = parentId ? markerContextById.get(parentId) : null;
      if (parent) {
        markerContextById.set(block.id, { chapterId: parent.chapterId, sceneId: parent.sceneId, rehearsalId: block.id });
      }
    }
  }

  return markerContextById;
}

export function withLegacyOwnershipProjection<T extends Block>(
  blocks: T[],
  markerContextById: ReadonlyMap<string, MarkerContext> = buildMarkerContextById(blocks),
): T[] {
  let changed = false;
  const projected = blocks.map((block) => {
    let sceneId: string | null;
    let rehearsalMark: string | null;
    if (block.type === "chapter_marker" || block.type === "scene_marker") {
      sceneId = block.id;
      rehearsalMark = null;
    } else if (block.type === "rehearsal_marker") {
      sceneId = null;
      rehearsalMark = null;
    } else {
      const context = block.ownerMarkerId ? markerContextById.get(block.ownerMarkerId) : undefined;
      sceneId = context?.sceneId ?? null;
      rehearsalMark = context?.rehearsalId ?? null;
    }
    if (block.sceneId === sceneId && block.rehearsalMark === rehearsalMark) return block;
    changed = true;
    return { ...block, sceneId, rehearsalMark };
  });
  return changed ? projected : blocks;
}

function withoutOwnerMarkerId<T extends Pick<Block, "ownerMarkerId">>(block: T): T {
  if (!("ownerMarkerId" in block)) return block;
  const rest = { ...block };
  delete rest.ownerMarkerId;
  return rest;
}

export function withMarkerOwnership<T extends Pick<Block, "id" | "type" | "ownerMarkerId" | "markerMeta">>(blocks: T[]): T[] {
  let currentChapterId: string | null = null;
  let currentParentMarkerId: string | null = null;
  let currentOwnerMarkerId: string | null = null;
  let changed = false;

  const next = blocks.map((block) => {
    if (block.type === "chapter_marker") {
      currentChapterId = block.id;
      currentParentMarkerId = block.id;
      currentOwnerMarkerId = block.id;
      if (block.markerMeta?.parentMarkerId === null && !("ownerMarkerId" in block)) return block;
      changed = true;
      return { ...withoutOwnerMarkerId(block), markerMeta: { ...block.markerMeta, parentMarkerId: null } };
    }

    if (block.type === "scene_marker") {
      const parentMarkerId = currentChapterId;
      currentParentMarkerId = block.id;
      currentOwnerMarkerId = block.id;
      if (block.markerMeta?.parentMarkerId === parentMarkerId && !("ownerMarkerId" in block)) return block;
      changed = true;
      return { ...withoutOwnerMarkerId(block), markerMeta: { ...block.markerMeta, parentMarkerId } };
    }

    if (block.type === "rehearsal_marker") {
      currentOwnerMarkerId = block.id;
      if (
        block.markerMeta?.parentMarkerId === currentParentMarkerId &&
        !("ownerMarkerId" in block)
      ) return block;
      changed = true;
      return {
        ...withoutOwnerMarkerId(block),
        markerMeta: { ...block.markerMeta, parentMarkerId: currentParentMarkerId },
      };
    }

    if (block.ownerMarkerId === currentOwnerMarkerId) return block;
    changed = true;
    return { ...block, ownerMarkerId: currentOwnerMarkerId };
  });

  return changed ? next : blocks;
}

export function textBlocksWithMarkerOwnership(blocks: Block[]): Block[] {
  return withMarkerOwnership(blocks).filter((block) => !isMarkerBlock(block));
}
