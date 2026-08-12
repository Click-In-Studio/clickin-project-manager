import { FIXED_INITIAL_CHAPTER_NAME } from "@/lib/script-fixed-markers";
import type { JointImportMappingRow, JointImportMarker } from "@/lib/import/types";

export function buildFinalImportMarkers(
  rows: JointImportMappingRow[],
  firstChapterAsOpening: boolean,
): Array<{ rowIndex: number; marker: JointImportMarker }> {
  const finalRows: Array<{ rowIndex: number; marker: JointImportMarker }> = [];
  const compactRows = rows.filter(row => row?.extracted || row?.imported);
  const seen = new Set<string>();
  let nextGeneratedChapterIndex = firstChapterAsOpening ? 0 : 1;
  const generatedNumBySourceNum = new Map<string, string>();
  const nextSceneIndexByGeneratedParent = new Map<string, number>();
  for (let rowIndex = 0; rowIndex < compactRows.length; rowIndex++) {
    const row = compactRows[rowIndex];
    if (!row) continue;
    const source = row.imported ?? row.extracted;
    if (!source) continue;
    const isScene = !!source.parentNum;
    const sourceNums = [row.extracted?.num, row.imported?.num].filter((num): num is string => !!num);
    const generatedParentNum = isScene
      ? (source.parentNum ? generatedNumBySourceNum.get(source.parentNum) ?? null : null)
      : null;
    const generatedNum = isScene
      ? `${generatedParentNum ?? "0"}-${nextSceneIndexByGeneratedParent.get(generatedParentNum ?? "0") ?? 1}`
      : String(nextGeneratedChapterIndex);
    const marker: JointImportMarker = {
      ...source,
      num: generatedNum,
      parentNum: generatedParentNum,
      name: firstChapterAsOpening && !isScene && generatedNum === "0"
        ? FIXED_INITIAL_CHAPTER_NAME
        : row.imported?.name || row.extracted?.name || source.name,
      sourceNums,
    };
    if (!marker.parentNum) {
      for (const sourceNum of sourceNums) generatedNumBySourceNum.set(sourceNum, marker.num);
      generatedNumBySourceNum.set(source.num, marker.num);
      nextSceneIndexByGeneratedParent.set(marker.num, 1);
      nextGeneratedChapterIndex++;
    } else {
      for (const sourceNum of sourceNums) generatedNumBySourceNum.set(sourceNum, marker.num);
      generatedNumBySourceNum.set(source.num, marker.num);
      nextSceneIndexByGeneratedParent.set(marker.parentNum, (nextSceneIndexByGeneratedParent.get(marker.parentNum) ?? 1) + 1);
    }
    if (seen.has(marker.num)) continue;
    seen.add(marker.num);
    finalRows.push({ rowIndex, marker });
  }
  return finalRows;
}
