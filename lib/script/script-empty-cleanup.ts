import type { SceneDetail } from "./script-scene-character-db";
import { isTextBlock } from "@/lib/script/script-block-layout";
import { isEmptyTextBlock, markerSegmentIsOpeningWithoutScene } from "@/lib/script/script-block-stream";
import { buildMarkerLabelIndex } from "@/lib/script/script-generated-labels";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import { hasNonNameSceneDetails } from "@/lib/script/script-scene-details";
import type { Block, Scene } from "@/lib/script/script-types";

export type EmptyScriptCleanupTarget = {
  id: string;
  key: string;
  label: string;
  kind: "chapter" | "scene" | "rehearsal";
  parentKey: string | null;
  dividerKey: string;
  chapterKey: string;
  disabledReason?: string;
};
export type EmptyScriptCleanupAnalysis = {
  targets: EmptyScriptCleanupTarget[];
  hasEmptyTextBlock: boolean;
};

export function buildEmptyScriptCleanupRemovalPlan(
  currentBlocks: Block[],
  selectedTargets: EmptyScriptCleanupTarget[],
) {
  const selectedSceneIds = new Set(
    selectedTargets
      .filter((target) => target.kind === "chapter" || target.kind === "scene")
      .map((target) => target.id)
  );
  const selectedRehearsalBlockIds = new Set(
    selectedTargets
      .filter((target) => target.kind === "rehearsal")
      .map((target) => target.id)
  );
  const deleteBlockIds = new Set<string>();
  let currentSectionSelected = false;
  let currentRehearsalSelected = false;
  for (const block of currentBlocks) {
    if (block.type === "chapter_marker") {
      currentSectionSelected = !!block.sceneId && selectedSceneIds.has(block.sceneId);
      currentRehearsalSelected = false;
      if (
        block.sceneId &&
        selectedSceneIds.has(block.sceneId)
      ) {
        deleteBlockIds.add(block.id);
      }
      continue;
    }
    if (block.type === "scene_marker") {
      currentSectionSelected = !!block.sceneId && selectedSceneIds.has(block.sceneId);
      currentRehearsalSelected = false;
      if (block.sceneId && selectedSceneIds.has(block.sceneId)) {
        deleteBlockIds.add(block.id);
      }
      continue;
    }
    if (block.type === "rehearsal_marker") {
      currentRehearsalSelected = currentSectionSelected || selectedRehearsalBlockIds.has(block.id);
      if (currentRehearsalSelected) {
        deleteBlockIds.add(block.id);
      }
      continue;
    }
    if (currentSectionSelected || currentRehearsalSelected) {
      deleteBlockIds.add(block.id);
    } else if (isEmptyTextBlock(block)) {
      deleteBlockIds.add(block.id);
    }
  }
  return { deleteBlockIds, selectedSceneIds };
}

export function isOnlyTextBlockInMarkerSegment(blocks: Block[], index: number, openingChapterMarkerId: string | null): boolean {
  const block = blocks[index];
  if (!block || isMarkerBlock(block)) return false;

  let start = index;
  while (start > 0) {
    const prev = blocks[start - 1];
    if (isMarkerBlock(prev)) break;
    start--;
  }
  if (markerSegmentIsOpeningWithoutScene(blocks, start - 1, openingChapterMarkerId)) return false;

  let textCount = 0;
  for (let cursor = start; cursor < blocks.length; cursor++) {
    const current = blocks[cursor];
    if (cursor !== start && isMarkerBlock(current)) break;
    if (isTextBlock(current)) textCount++;
    if (textCount > 1) return false;
  }
  return textCount === 1;
}

export function analyzeEmptyScriptCleanup(
  blocks: Block[],
  scenes: Scene[],
  sceneDetailById: Map<string, SceneDetail>,
  openingChapterMarkerId: string | null,
  options?: { includeOpeningChapter?: boolean }
): EmptyScriptCleanupAnalysis {
  const textCountsBySceneId = new Map<string, number>();
  const textCountsByRehearsalBlockId = new Map<string, number>();
  const rehearsalTargetById = new Map<string, EmptyScriptCleanupTarget>();
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const rehearsalLabelByMarkerId = buildMarkerLabelIndex(blocks).rehearsalLabelByMarkerId;
  const chapterMarkerBlocks: Block[] = [];
  const sceneMarkerBlocks: Block[] = [];
  let hasEmptyTextBlock = false;
  let currentSceneId: string | null = null;
  let currentRehearsalBlockId: string | null = null;

  for (const block of blocks) {
    if (block.type === "chapter_marker") {
      chapterMarkerBlocks.push(block);
      currentSceneId = block.sceneId;
      currentRehearsalBlockId = null;
      continue;
    }
    if (block.type === "scene_marker") {
      sceneMarkerBlocks.push(block);
      currentSceneId = block.sceneId;
      currentRehearsalBlockId = null;
      continue;
    }
    if (block.type === "rehearsal_marker") {
      currentRehearsalBlockId = block.id;
      if (currentSceneId) {
        const parentScene = sceneById.get(currentSceneId) ?? null;
        const parentKind = parentScene?.parentId === null ? "chapter" : "scene";
        const parentKey = `${parentKind}:${currentSceneId}`;
        const rehearsalLabel = [
          parentScene?.number.trim(),
          rehearsalLabelByMarkerId.get(block.id),
        ].filter(Boolean).join("-");
        rehearsalTargetById.set(block.id, {
          id: block.id,
          key: `rehearsal:${block.id}`,
          label: rehearsalLabel || "未命名排练记号",
          kind: "rehearsal",
          parentKey,
          dividerKey: currentSceneId,
          chapterKey: parentScene?.parentId ?? currentSceneId,
        });
      }
      continue;
    }
    if (isMarkerBlock(block)) continue;
    if (isEmptyTextBlock(block)) {
      hasEmptyTextBlock = true;
      continue;
    }
    if (!currentSceneId) continue;
    textCountsBySceneId.set(currentSceneId, (textCountsBySceneId.get(currentSceneId) ?? 0) + 1);
    if (currentRehearsalBlockId) {
      textCountsByRehearsalBlockId.set(
        currentRehearsalBlockId,
        (textCountsByRehearsalBlockId.get(currentRehearsalBlockId) ?? 0) + 1
      );
    }
  }

  const removableSceneIds = new Set<string>();
  const removableChapterIds = new Set<string>();
  const childSceneIdsByChapter = new Map<string, string[]>();
  for (const scene of scenes) {
    if (!scene.parentId) continue;
    const childIds = childSceneIdsByChapter.get(scene.parentId);
    if (childIds) childIds.push(scene.id);
    else childSceneIdsByChapter.set(scene.parentId, [scene.id]);
  }

  for (const block of sceneMarkerBlocks) {
    if (!block.sceneId) continue;
    if ((textCountsBySceneId.get(block.sceneId) ?? 0) > 0) continue;
    removableSceneIds.add(block.sceneId);
  }

  for (const block of chapterMarkerBlocks) {
    if (!block.sceneId) continue;
    if (!options?.includeOpeningChapter && block.id === openingChapterMarkerId) continue;
    const chapterHasOwnText = (textCountsBySceneId.get(block.sceneId) ?? 0) > 0;
    const chapterHasRemainingScene = (childSceneIdsByChapter.get(block.sceneId) ?? [])
      .some((sceneId) => !removableSceneIds.has(sceneId));
    if (chapterHasOwnText || chapterHasRemainingScene) continue;
    removableChapterIds.add(block.sceneId);
  }

  const makeSectionTarget = (scene: Scene, markerMeta?: Block["markerMeta"]): EmptyScriptCleanupTarget => {
    const kind = scene.parentId === null ? "chapter" : "scene";
    const label = [scene.number.trim(), scene.name.trim()].filter(Boolean).join(" ") ||
      (kind === "chapter" ? "未命名章节" : "未命名段落");
    const hasDetails = hasNonNameSceneDetails(sceneDetailById.get(scene.id), markerMeta, kind === "chapter");
    return {
      id: scene.id,
      key: `${kind}:${scene.id}`,
      label,
      kind,
      parentKey: scene.parentId ? `chapter:${scene.parentId}` : null,
      dividerKey: scene.id,
      chapterKey: scene.parentId ?? scene.id,
      disabledReason: hasDetails ? (kind === "chapter" ? "章节详情不为空" : "段落详情不为空") : undefined,
    };
  };

  const targets: EmptyScriptCleanupTarget[] = [];
  const seenTargetKeys = new Set<string>();
  for (const block of blocks) {
    let target: EmptyScriptCleanupTarget | null = null;
    if (block.type === "chapter_marker" && block.sceneId && removableChapterIds.has(block.sceneId)) {
      const scene = sceneById.get(block.sceneId);
      if (scene) target = makeSectionTarget(scene, block.markerMeta);
    } else if (block.type === "scene_marker" && block.sceneId && removableSceneIds.has(block.sceneId)) {
      const scene = sceneById.get(block.sceneId);
      if (scene) target = makeSectionTarget(scene, block.markerMeta);
    } else if (block.type === "rehearsal_marker") {
      const rehearsalTarget = rehearsalTargetById.get(block.id) ?? null;
      target = rehearsalTarget && (textCountsByRehearsalBlockId.get(rehearsalTarget.id) ?? 0) === 0
        ? rehearsalTarget
        : null;
    }
    if (!target || seenTargetKeys.has(target.key)) continue;
    seenTargetKeys.add(target.key);
    targets.push(target);
  }
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const protectedChildSceneNumbersByChapter = new Map<string, string[]>();
  for (const target of targets) {
    if (target.kind !== "scene" || !target.disabledReason || !target.parentKey) continue;
    const childSceneNumbers = protectedChildSceneNumbersByChapter.get(target.parentKey) ?? [];
    childSceneNumbers.push(sceneById.get(target.id)?.number.trim() || target.label);
    protectedChildSceneNumbersByChapter.set(target.parentKey, childSceneNumbers);
  }
  for (const [chapterKey, childSceneNumbers] of protectedChildSceneNumbersByChapter) {
    const chapter = targetByKey.get(chapterKey);
    if (!chapter || chapter.disabledReason) continue;
    chapter.disabledReason = `子段落详情不为空：${childSceneNumbers.join("、")}`;
  }
  return { targets, hasEmptyTextBlock };
}
