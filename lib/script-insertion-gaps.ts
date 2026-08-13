import type { Block, Scene } from "./script-types";

export function isProtectedChapterSceneGap(
  previous: Block | null,
  next: Block | null,
  sceneParentIdById: ReadonlyMap<string, string | null>,
): boolean {
  return !!(
    previous?.type === "chapter_marker" &&
    next?.type === "scene_marker" &&
    previous.sceneId &&
    next.sceneId &&
    sceneParentIdById.get(next.sceneId) === previous.sceneId
  );
}

export function hasScriptInsertionGapBefore(
  blocks: readonly Block[],
  index: number,
  sceneParentIdById: ReadonlyMap<string, string | null>,
): boolean {
  if (index <= 0 || index >= blocks.length) return false;
  return !isProtectedChapterSceneGap(blocks[index - 1] ?? null, blocks[index] ?? null, sceneParentIdById);
}

export function sceneParentIdMap(scenes: readonly Scene[]): Map<string, string | null> {
  return new Map(scenes.map(scene => [scene.id, scene.parentId]));
}
