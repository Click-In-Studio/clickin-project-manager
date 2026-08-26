/**
 * 块级排版判据（角色名省略、角色间距、场次边界）。
 * 编辑器渲染与打印分页共用同一份——分歧会直接变成「屏上分页与纸上分页不一致」。
 */
import type { Block } from "./script-types";
import { isMarkerBlock } from "./script-marker-blocks";

export const isTextBlock = (block: Block) => !isMarkerBlock(block);

/**
 * 两个角色列表是否是同一组。
 *
 * 按**多重集**比而不是集合比：原先用 `new Set(a)` + `b.every(...)`，
 * `a=[x,y]` 与 `b=[x,x]` 会判成相同（长度相等、b 的元素都在 a 的集合里），
 * 于是角色名被错误省略。characterIds 上游大概率不会出现重复，但这个前提
 * 没有任何地方保证，而代价只是排序一次。
 */
export function sameCharacters(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((id, i) => id === sb[i]);
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
