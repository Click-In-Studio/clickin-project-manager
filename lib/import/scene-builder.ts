import { randomUUID } from "node:crypto";
import { parseSceneNum } from "./parse-scene-num";
import type { SceneColMap, ParsedSceneNum } from "./types";

export type SceneRow = {
  rawNum: string;
  parsed: ParsedSceneNum;
  /** Name for the scene this row represents (child if present, else parent). NOT the parent act's name. */
  name: string | null;
  /** Name for the implied parent act from this row (only when childNum is set). */
  impliedParentName: string | null;
  intro: string | null;
  actionLine: string | null;
  music: string | null;
  stagePres: string | null;
  duration: string | null;
};

export type SceneEntry = {
  id: string;
  num: string;
  name: string;
  parentNum: string | null;
  sortOrder: number;
};

export function buildSceneRows(rows: (string | null)[][], colMap: SceneColMap, headerRowIncluded?: boolean): SceneRow[] {
  const headerIndex = headerRowIncluded ? rows.findIndex(row => row.some(cell => cell?.trim())) : -1;
  const dataRows = headerRowIncluded && headerIndex >= 0
    ? rows.filter((_, index) => index !== headerIndex)
    : rows;
  const results: SceneRow[] = [];

  for (const row of dataRows) {
    const rawNum = row[colMap.sceneNum]?.trim();
    if (!rawNum) continue;

    const parsed = parseSceneNum(rawNum);
    if (!parsed) continue;

    let name: string | null = colMap.sceneName != null ? row[colMap.sceneName]?.trim() || null : null;
    if (!name) {
      name = parsed.childNum ? parsed.childName : parsed.parentName;
    }

    const impliedParentName = parsed.childNum ? parsed.parentName : null;

    results.push({
      rawNum,
      parsed,
      name,
      impliedParentName,
      intro: colMap.intro != null ? row[colMap.intro]?.trim() || null : null,
      actionLine: colMap.actionLine != null ? row[colMap.actionLine]?.trim() || null : null,
      music: colMap.music != null ? row[colMap.music]?.trim() || null : null,
      stagePres: colMap.stagePres != null ? row[colMap.stagePres]?.trim() || null : null,
      duration: colMap.duration != null ? row[colMap.duration]?.trim() || null : null,
    });
  }
  return results;
}

/**
 * Build a deduplicated Map<sceneNumber, entry> from sceneRows.
 * Parent acts come from:
 *   - rows where childNum is null (explicit act rows)
 *   - rows where childNum is set and parentNum is present (implied acts)
 * Child scenes only appear once.
 */
export function buildSceneMap(
  sceneRows: SceneRow[],
  existingByNum: Map<string, { id: string; number: string; name: string }>,
  initialSortOrder: number,
): Map<string, SceneEntry> {
  const map = new Map<string, SceneEntry>();
  let sortOrder = initialSortOrder;

  function getOrCreateScene(num: string, name: string | null, parentNum: string | null): SceneEntry {
    if (map.has(num)) {
      const e = map.get(num)!;
      if (name && !e.name) map.set(num, { ...e, name });
      return map.get(num)!;
    }
    const ex = existingByNum.get(num);
    const entry: SceneEntry = {
      id: ex?.id ?? randomUUID(),
      num,
      name: name ?? ex?.name ?? "",
      parentNum,
      sortOrder: ex ? -1 : sortOrder++,
    };
    map.set(num, entry);
    return entry;
  }

  for (const row of sceneRows) {
    const { parsed, name, impliedParentName } = row;

    if (parsed.childNum && parsed.parentNum) {
      getOrCreateScene(parsed.parentNum, impliedParentName, null);
      getOrCreateScene(parsed.childNum, name, parsed.parentNum);
    } else if (parsed.parentNum) {
      getOrCreateScene(parsed.parentNum, name, null);
    }
  }

  return map;
}
