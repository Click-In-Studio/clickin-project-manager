import type { TagGroup, BlockTagValue } from "./script-block-tag-db";
import type { SceneDetail } from "./script-scene-character-db";
import { formatDuration, parseDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/ops/scene-duration";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import type { Block, Scene } from "@/lib/script/script-types";

/**
 * Computes the `lyric` flag a block should have based on its tags and the
 * production's lyricSplitAfterOptionId rules (OR logic across groups).
 *
 * Returns null if none of the block's tag groups has a lyric-split rule —
 * meaning the caller should leave block.lyric unchanged.
 */
export function computeLyricFromTags(tags: BlockTagValue[], tagGroups: TagGroup[]): boolean | null {
  const lyricGroups = tagGroups.filter(g => g.lyricSplitAfterOptionId);
  if (lyricGroups.length === 0) return null;
  for (const tag of tags) {
    if (!tag.optionId) continue;
    const group = lyricGroups.find(g => g.id === tag.groupId);
    if (!group) continue;
    const splitOpt = group.options.find(o => o.id === group.lyricSplitAfterOptionId);
    const selOpt = group.options.find(o => o.id === tag.optionId);
    if (!splitOpt || !selOpt) continue;
    if (selOpt.sortOrder <= splitOpt.sortOrder) return true;
  }
  // Has lyric groups, but no tag qualifies → false
  const blockHasLyricGroup = tags.some(t => lyricGroups.some(g => g.id === t.groupId));
  return blockHasLyricGroup ? false : null;
}

export type SceneMetaFields = Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">;
export type MarkerDetailDeleteBlockedKind = "chapter" | "scene";
export type NonEmptyDramaturgyMarker = {
  id: string;
  kind: MarkerDetailDeleteBlockedKind;
};
export type MarkerDetailField = {
  label: string;
  value: string;
};

export function hasTextValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasNonNameSceneDetails(
  detail?: Partial<SceneMetaFields> | null,
  markerMeta?: Partial<SceneMetaFields> | null,
  ignoreExpectedDuration = false
): boolean {
  const hasExpectedDuration = !ignoreExpectedDuration && (
    hasTextValue(markerMeta?.expectedDuration) ||
    hasTextValue(detail?.expectedDuration)
  );
  return (
    hasTextValue(markerMeta?.synopsis) ||
    hasTextValue(markerMeta?.actionLine) ||
    hasTextValue(markerMeta?.music) ||
    hasTextValue(markerMeta?.stageNotes) ||
    hasTextValue(detail?.synopsis) ||
    hasTextValue(detail?.actionLine) ||
    hasTextValue(detail?.music) ||
    hasTextValue(detail?.stageNotes) ||
    hasExpectedDuration
  );
}

export function sceneDetailDeleteBlockedMessage(kind: MarkerDetailDeleteBlockedKind): string {
  const label = kind === "chapter" ? "章节" : "段落";
  return `${label}详情不为空，不可删除当前${label}块。\n如需删除，请确保详情内容均已转移或清空。`;
}

export function markerBlockDramaturgyDeleteBlockedKind(block: Block, detail?: SceneDetail | null): MarkerDetailDeleteBlockedKind | null {
  if (block.type !== "chapter_marker" && block.type !== "scene_marker") return null;
  const markerMeta = block.markerMeta ?? {};
  const hasDetails = hasNonNameSceneDetails(detail, markerMeta, block.type === "chapter_marker");
  if (!hasDetails) return null;
  return block.type === "chapter_marker" ? "chapter" : "scene";
}

export function markerDetailFields(block: Block, detail: SceneDetail | null): MarkerDetailField[] {
  if (block.type !== "chapter_marker" && block.type !== "scene_marker") return [];
  const markerMeta = block.markerMeta ?? {};
  const fields: Array<[string, keyof SceneMetaFields]> = [
    ["简介", "synopsis"],
    ["行动线", "actionLine"],
    ["音乐", "music"],
    ["舞台呈现", "stageNotes"],
  ];
  return fields.map(([label, key]) => {
    const value = markerMeta[key] || detail?.[key] || "";
    return { label, value: value.trim() };
  });
}

export function markerExpectedDuration(block: Block, detail: SceneDetail | null, scenes: SceneDetail[]): string {
  if (block.type === "chapter_marker" && block.sceneId) {
    const chapterDuration = getChapterDurationDisplay(scenes.filter((scene) => scene.parentId === block.sceneId));
    return !chapterDuration || chapterDuration.hasMissingDuration ? "—" : chapterDuration.text || "—";
  }
  const value = block.markerMeta?.expectedDuration || detail?.expectedDuration || "";
  if (!hasTextValue(value)) return "—";
  return formatDuration(parseDuration(value)) || "—";
}

export function buildOrderedTocScenes(scenes: Scene[], blocks: Block[]): Scene[] {
  const usesMarkerBlocks = blocks.some(isMarkerBlock);
  const usedSceneIds = new Set(blocks.map((b) => b.sceneId).filter((id): id is string => id !== null));
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const usedOrdered: Scene[] = [];
  const usedOrderedIds = new Set<string>();
  for (const b of blocks) {
    if (b.sceneId) {
      const scene = sceneById.get(b.sceneId);
      if (scene && !usedOrderedIds.has(scene.id)) {
        usedOrderedIds.add(scene.id);
        usedOrdered.push(scene);
      }
    }
  }
  if (usedOrdered.length === 0 && usedSceneIds.size === 0) return [];
  if (usesMarkerBlocks) return usedOrdered;

  const orderedScenes: Scene[] = [];
  const orderedSceneIds = new Set<string>();
  const pushOrderedScene = (scene: Scene) => {
    if (orderedSceneIds.has(scene.id)) return;
    orderedSceneIds.add(scene.id);
    orderedScenes.push(scene);
  };

  for (let i = 0; i < usedOrdered.length; i++) {
    const prevIdx = i === 0 ? -1 : scenes.findIndex((s) => s.id === usedOrdered[i - 1].id);
    const currIdx = scenes.findIndex((s) => s.id === usedOrdered[i].id);
    for (let j = prevIdx + 1; j < currIdx; j++) {
      if (!usedSceneIds.has(scenes[j].id)) pushOrderedScene(scenes[j]);
    }
    pushOrderedScene(usedOrdered[i]);
  }

  const lastIdx = usedOrdered.length
    ? scenes.findIndex((s) => s.id === usedOrdered[usedOrdered.length - 1].id)
    : -1;
  for (let j = lastIdx + 1; j < scenes.length; j++) {
    if (!usedSceneIds.has(scenes[j].id)) pushOrderedScene(scenes[j]);
  }

  return orderedScenes;
}

export function toSceneDetail(scene: Scene): SceneDetail {
  return {
    ...scene,
    synopsis: "",
    actionLine: "",
    music: "",
    stageNotes: "",
    expectedDuration: "",
  };
}

export function syncSceneDetailsWithScenes(details: SceneDetail[], scenes: Scene[]): SceneDetail[] {
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  const next = scenes.map((scene) => ({ ...(detailById.get(scene.id) ?? toSceneDetail(scene)), ...scene }));
  return sameSceneDetails(next, details) ? details : next;
}

export function sameSceneRows(a: Scene[], b: Scene[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((scene, index) => {
    const other = b[index];
    return !!other &&
      scene.id === other.id &&
      scene.number === other.number &&
      scene.name === other.name &&
      scene.parentId === other.parentId;
  });
}

export function sameSceneDetails(a: SceneDetail[], b: SceneDetail[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((scene, index) => {
    const other = b[index];
    return !!other &&
      scene.id === other.id &&
      scene.number === other.number &&
      scene.name === other.name &&
      scene.parentId === other.parentId &&
      scene.synopsis === other.synopsis &&
      scene.actionLine === other.actionLine &&
      scene.music === other.music &&
      scene.stageNotes === other.stageNotes &&
      scene.expectedDuration === other.expectedDuration;
  });
}
