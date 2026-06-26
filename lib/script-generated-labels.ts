import type { Scene } from "./script-types";

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
