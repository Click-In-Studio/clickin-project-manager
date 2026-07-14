import type { Block } from "./script-types";

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

export function withMarkerOwnership<T extends Pick<Block, "id" | "type" | "sceneId" | "rehearsalMark" | "markerMeta">>(blocks: T[]): T[] {
  let currentSceneId: string | null = null;
  let currentParentMarkerId: string | null = null;
  let currentRehearsalMark: string | null = null;
  let changed = false;

  const next = blocks.map((block) => {
    if (block.type === "chapter_marker" || block.type === "scene_marker") {
      currentSceneId = block.sceneId;
      currentParentMarkerId = block.id;
      currentRehearsalMark = null;
      if (block.rehearsalMark === null) return block;
      changed = true;
      return { ...block, rehearsalMark: null };
    }

    if (block.type === "rehearsal_marker") {
      currentRehearsalMark = block.id;
      if (
        block.sceneId === null &&
        block.rehearsalMark === null &&
        block.markerMeta?.parentMarkerId === currentParentMarkerId
      ) return block;
      changed = true;
      return {
        ...block,
        sceneId: null,
        rehearsalMark: null,
        markerMeta: { ...block.markerMeta, parentMarkerId: currentParentMarkerId },
      };
    }

    if (block.sceneId === currentSceneId && block.rehearsalMark === currentRehearsalMark) return block;
    changed = true;
    return { ...block, sceneId: currentSceneId, rehearsalMark: currentRehearsalMark };
  });

  return changed ? next : blocks;
}

export function textBlocksWithMarkerOwnership(blocks: Block[]): Block[] {
  return withMarkerOwnership(blocks).filter((block) => !isMarkerBlock(block));
}
