import type { Block, Scene } from "./script-types";

export type MarkerLabelIndex = {
  readonly labelByMarkerId: ReadonlyMap<string, string>;
  readonly rehearsalLabelByMarkerId: ReadonlyMap<string, string>;
  readonly markerIdByParentAndLabel: ReadonlyMap<string, string>;
  readonly parentIdByMarkerId: ReadonlyMap<string, string>;
};

export function toAlphaLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    n--;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return label;
}

export function buildMarkerLabelIndex(
  blocks: Array<Pick<Block, "id" | "type" | "markerMeta">>,
): MarkerLabelIndex {
  const labelByMarkerId = new Map<string, string>();
  const rehearsalLabelByMarkerId = new Map<string, string>();
  const markerIdByParentAndLabel = new Map<string, string>();
  const parentIdByMarkerId = new Map<string, string>();
  const markers: typeof blocks = [];
  let chapterCount = 0;
  for (const block of blocks) {
    if (block.type !== "chapter_marker" && block.type !== "scene_marker" && block.type !== "rehearsal_marker") continue;
    markers.push(block);
    if (block.type === "chapter_marker") chapterCount++;
  }
  const chapterWidth = String(Math.max(0, chapterCount - 1)).length;
  const sceneCountByChapterId = new Map<string, number>();
  const rehearsalCountByParentId = new Map<string, number>();
  let chapterIndex = 0;

  for (const block of markers) {
    const parentId = block.markerMeta?.parentMarkerId;
    if (block.type === "chapter_marker") {
      const label = String(chapterIndex++).padStart(chapterWidth, "0");
      labelByMarkerId.set(block.id, label);
      sceneCountByChapterId.set(block.id, 0);
    } else if (block.type === "scene_marker" && parentId) {
      const sceneIndex = (sceneCountByChapterId.get(parentId) ?? 0) + 1;
      sceneCountByChapterId.set(parentId, sceneIndex);
      const localLabel = String(sceneIndex);
      const label = `${labelByMarkerId.get(parentId) ?? "0".padStart(chapterWidth, "0")}-${localLabel}`;
      labelByMarkerId.set(block.id, label);
      parentIdByMarkerId.set(block.id, parentId);
    } else if (block.type === "rehearsal_marker" && parentId) {
      const rehearsalIndex = rehearsalCountByParentId.get(parentId) ?? 0;
      rehearsalCountByParentId.set(parentId, rehearsalIndex + 1);
      const localLabel = toAlphaLabel(rehearsalIndex);
      const label = `${labelByMarkerId.get(parentId) ?? ""}-${localLabel}`;
      labelByMarkerId.set(block.id, label);
      rehearsalLabelByMarkerId.set(block.id, localLabel);
      markerIdByParentAndLabel.set(`${parentId}\u0000${localLabel}`, block.id);
      parentIdByMarkerId.set(block.id, parentId);
    }
  }

  return { labelByMarkerId, rehearsalLabelByMarkerId, markerIdByParentAndLabel, parentIdByMarkerId };
}

export function generatedRehearsalMarksByScene(
  rows: Array<{ sceneId: string | null; rehearsalMark: string | null; type?: string }>
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  let currentSceneId: string | null = null;
  let currentSourceMark: string | null | undefined = undefined;
  let rehearsalIndex = 0;

  for (const row of rows) {
    if (row.sceneId && row.sceneId !== currentSceneId) {
      currentSceneId = row.sceneId;
      currentSourceMark = undefined;
      rehearsalIndex = 0;
    }

    if (row.type === "rehearsal_marker") {
      if (!currentSceneId || !row.rehearsalMark) continue;
      if (row.rehearsalMark === currentSourceMark) continue;
      currentSourceMark = row.rehearsalMark;
      const label = toAlphaLabel(rehearsalIndex);
      rehearsalIndex++;
      if (!map[currentSceneId]) map[currentSceneId] = [];
      map[currentSceneId].push(label);
      continue;
    }

    if (!row.sceneId) continue;
    if (!row.rehearsalMark) {
      currentSourceMark = null;
      continue;
    }

    if (row.rehearsalMark === currentSourceMark) continue;
    currentSourceMark = row.rehearsalMark;
    const label = toAlphaLabel(rehearsalIndex);
    rehearsalIndex++;
    if (!map[row.sceneId]) map[row.sceneId] = [];
    map[row.sceneId].push(label);
  }

  return map;
}

export function withMarkerSceneLabels<T extends Scene>(scenes: T[]): T[] {
  const labels = buildMarkerLabelIndex(scenes.map((scene) => ({
    id: scene.id,
    type: scene.parentId === null ? "chapter_marker" as const : "scene_marker" as const,
    markerMeta: { parentMarkerId: scene.parentId },
  })));
  return scenes.map((scene) => ({
    ...scene,
    number: labels.labelByMarkerId.get(scene.id) ?? "",
  }));
}
