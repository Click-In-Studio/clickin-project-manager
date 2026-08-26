/**
 * 块级排版判据（角色名省略、角色间距、场次边界）。
 * 编辑器渲染与打印分页共用同一份——分歧会直接变成「屏上分页与纸上分页不一致」。
 */
import type { Block } from "./script-types";
import { isMarkerBlock } from "./script-marker-blocks";

export const isTextBlock = (block: Block) => !isMarkerBlock(block);

export function sameCharacters(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

export function shouldHideCharacterLabel(prev: Block | null, block: Block): boolean {
  if (block.forceShowCharacterName) return false;
  if (!prev || prev.type !== "dialogue" || block.type !== "dialogue") return false;
  if (block.sceneId !== prev.sceneId) return false;
  if (block.rehearsalMark !== prev.rehearsalMark) return false;
  return sameCharacters(prev.characterIds, block.characterIds);
}

export function shouldShowCharacterGap(prev: Block | null, block: Block, hideChar: boolean): boolean {
  if (!prev) return false;
  if (isMarkerBlock(prev) || isMarkerBlock(block)) return false;
  if (block.type === "stage") return prev.type !== "stage";
  if (block.type === "dialogue" && block.characterIds.length === 0) {
    return !(
      prev.type === "dialogue" &&
      prev.characterIds.length === 0 &&
      block.sceneId === prev.sceneId &&
      block.rehearsalMark === prev.rehearsalMark
    );
  }
  return block.type === "dialogue" && block.characterIds.length > 0 && !hideChar;
}

export function shouldShowSceneEndGap(prev: Block | null, block: Block): boolean {
  if (!prev || isMarkerBlock(prev)) return false;
  return block.type === "chapter_marker" || block.type === "scene_marker";
}

export function isSceneBoundaryBlock(block: Block, prev: Block | null): boolean {
  if (isMarkerBlock(block)) return block.type === "chapter_marker" || block.type === "scene_marker";
  if (prev && isMarkerBlock(prev)) return false;
  return block.sceneId !== null && block.sceneId !== prev?.sceneId;
}
