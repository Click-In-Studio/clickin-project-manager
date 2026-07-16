import type { Block, Scene } from "./script-types";

export function localMarkerNumber(number: string, kind: "chapter" | "scene"): string {
  const parts = number.trim().split("-").map((part) => part.trim()).filter(Boolean);
  if (kind === "chapter") return parts[0] ?? "";
  return [...parts].reverse().find((part) => /^\d+$/.test(part)) ?? parts.at(-1) ?? "";
}

export function localSceneNumber(number: string, parentId: string | null): string {
  return localMarkerNumber(number, parentId === null ? "chapter" : "scene");
}

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

export function withGeneratedSceneNumbers<T extends Scene>(scenes: T[]): T[] {
  let changed = false;
  let chapterIndex = 0;
  const chapterCount = scenes.reduce((count, scene) => scene.parentId === null ? count + 1 : count, 0);
  const chapterWidth = String(Math.max(0, chapterCount - 1)).length;
  const sceneIndexByChapterId = new Map<string, number>();
  const numberById = new Map<string, string>();

  const next = scenes.map((scene) => {
    let generatedNumber: string;
    if (scene.parentId === null) {
      generatedNumber = String(chapterIndex).padStart(chapterWidth, "0");
      chapterIndex++;
      sceneIndexByChapterId.set(scene.id, 0);
    } else {
      const chapterNumber = numberById.get(scene.parentId) ?? "0".padStart(chapterWidth, "0");
      const sceneIndex = (sceneIndexByChapterId.get(scene.parentId) ?? 0) + 1;
      sceneIndexByChapterId.set(scene.parentId, sceneIndex);
      generatedNumber = `${chapterNumber}-${sceneIndex}`;
    }
    numberById.set(scene.id, generatedNumber);
    if (scene.number === generatedNumber) return scene;
    changed = true;
    return { ...scene, number: generatedNumber };
  });

  return changed ? next : scenes;
}

export function generatedRehearsalLabels(
  blocks: Array<Pick<Block, "id" | "type" | "markerMeta">>,
) {
  const labelByMarkerId = new Map<string, string>();
  const markerIdByParentAndLabel = new Map<string, string>();
  const parentIdByMarkerId = new Map<string, string>();
  const rehearsalCountByParentId = new Map<string, number>();

  for (const block of blocks) {
    const parentId = block.markerMeta?.parentMarkerId;
    if (block.type !== "rehearsal_marker" || !parentId) continue;
    const rehearsalIndex = rehearsalCountByParentId.get(parentId) ?? 0;
    rehearsalCountByParentId.set(parentId, rehearsalIndex + 1);
    const label = toAlphaLabel(rehearsalIndex);
    labelByMarkerId.set(block.id, label);
    markerIdByParentAndLabel.set(`${parentId}\u0000${label}`, block.id);
    parentIdByMarkerId.set(block.id, parentId);
  }

  return { labelByMarkerId, markerIdByParentAndLabel, parentIdByMarkerId };
}
