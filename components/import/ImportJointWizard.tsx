"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import SheetPicker from "./SheetPicker";
import ColumnMapper from "./ColumnMapper";
import type { SheetMeta, SheetData, SceneColMap, ScriptColMap, ImportScriptPreview, TypeAction, TypeTagMapping, AggregateMembers, StageDelimiterPattern, ScriptConfigStageDelimiterPattern, JointImportPreview, JointImportMappingRow, JointImportMarker } from "@/lib/import/types";

type Step = "choose-dramaturgy" | "choose-script" | "scene-columns" | "script-columns" | "types" | "characters" | "aggregates" | "preview" | "done";
type Props = { productionId: string; versionId?: string | null; onDone?: () => void; };
type CharEntry = { raw: string; parsedBase: string; parsedSuffix: string | null; mergeAsNote: boolean; kind: "normal" | "aggregate" };
type TagGroupInfo = { id: string; name: string; options: { id: string; label: string; color: string }[] };
type Workbook = { token: string; sheets: SheetMeta[] };
type SheetPickerPreset = { url: string; token: string; sheets: SheetMeta[]; nonce: number };
type ApiResult<T> = Partial<T> & { error?: string; status?: string; migration?: { phase?: string } };
type JointImportMappingAction = "create" | "preserve";
type SceneSummaryItem = { sceneId: string | null; num: string | null; name: string | null; count: number };
type TagTypeAction = Extract<TypeAction, { action: "mapTag" }>;

async function readApiResult<T>(res: Response, fallback: string): Promise<ApiResult<T>> {
  const text = await res.text();
  if (!text) return {} as ApiResult<T>;
  try {
    const data = JSON.parse(text) as ApiResult<T>;
    if (data.status === "updating") {
      return { error: data.migration?.phase ? `剧本数据正在更新：${data.migration.phase}` : "剧本数据正在更新，请稍后重试" } as ApiResult<T>;
    }
    return data;
  } catch {
    return { error: `${fallback}（HTTP ${res.status}）：${text.slice(0, 120)}` } as ApiResult<T>;
  }
}

function parseCharName(raw: string): { name: string; note: string | null } {
  const s = raw.trim();
  const parenMatch = s.match(/^(.+?)[（(](.+?)[）)]\s*$/);
  if (parenMatch) return { name: parenMatch[1].trim(), note: parenMatch[2].trim() };
  const suffixMatch = s.match(/^(.+?)([A-Z]{1,4})$/);
  if (suffixMatch && suffixMatch[1].trim() && /[^\x00-\x7F]/.test(suffixMatch[1])) return { name: suffixMatch[1].trim(), note: suffixMatch[2] };
  return { name: s, note: null };
}
const guessAgg = (name: string) => /们|全体|合唱|合|众|群/.test(name);
const effectiveName = (e: CharEntry) => e.parsedSuffix !== null && e.mergeAsNote ? e.parsedBase : e.raw;
const splitCellValues = (value: string) => value.split(/[,，;；、/\n]+/).map(s => s.trim()).filter(Boolean);
const STAGE_DELIMITER_PATTERNS: StageDelimiterPattern[] = ["（）", "【】", "()", "[]"];
const SCRIPT_CONFIG_STAGE_DELIMITER_PATTERNS: ScriptConfigStageDelimiterPattern[] = ["（）", "【】"];
const BLOCK_TYPE_LABELS: Record<string, string> = { dialogue: "台词", stage: "舞台提示", lyric: "歌词", marker: "章节分界线" };
const MAPPING_BUTTON_CLASS = "px-2 py-0.5 rounded border text-xs disabled:opacity-25 disabled:cursor-not-allowed";
const MAPPING_CURRENT_BUTTON_CLASS = "px-2 py-0.5 rounded border text-xs cursor-not-allowed";
const DEFAULT_TYPE_ACTION: Extract<TypeAction, { action: "mapType" }> = { action: "mapType", blockType: "dialogue" };

function normalizeTypeActions(action: TypeTagMapping[string] | undefined): TypeAction[] {
  if (!action) return [DEFAULT_TYPE_ACTION];
  return Array.isArray(action) ? action : [action];
}

function primaryTypeAction(action: TypeTagMapping[string] | undefined): TypeAction {
  return normalizeTypeActions(action).find(item => item.action !== "mapTag") ?? DEFAULT_TYPE_ACTION;
}

function tagActions(action: TypeTagMapping[string] | undefined): TagTypeAction[] {
  return normalizeTypeActions(action).filter((item): item is TagTypeAction => item.action === "mapTag");
}
export default function ImportJointWizard({ productionId, versionId, onDone }: Props) {
  const [step, setStep] = useState<Step>("choose-dramaturgy");
  const [dramWorkbook, setDramWorkbook] = useState<Workbook | null>(null);
  const [dramWorkbookUrl, setDramWorkbookUrl] = useState("");
  const [skipDramaturgy, setSkipDramaturgy] = useState(false);
  const [scriptWorkbook, setScriptWorkbook] = useState<Workbook | null>(null);
  const [scriptPickerPreset, setScriptPickerPreset] = useState<SheetPickerPreset | null>(null);
  const [hasSceneHeader, setHasSceneHeader] = useState(true);
  const [hasScriptHeader, setHasScriptHeader] = useState(true);
  const [dramSheet, setDramSheet] = useState<SheetMeta | null>(null);
  const [scriptSheet, setScriptSheet] = useState<SheetMeta | null>(null);
  const [dramData, setDramData] = useState<SheetData | null>(null);
  const [scriptData, setScriptData] = useState<SheetData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [loadingScriptOption, setLoadingScriptOption] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [sceneMapping, setSceneMapping] = useState<Record<string, number | null>>({ sceneNum: null, sceneName: null, intro: null, actionLine: null, music: null, stagePres: null, duration: null });
  const [scriptMapping, setScriptMapping] = useState<Record<string, number | number[] | null>>({ sceneNum: null, rehearsalMark: null, typeTag: null, character: null, stageComment: null, bodyColumns: [], stageInlineColumns: [] });
  const [stageInlinePatterns, setStageInlinePatterns] = useState<StageDelimiterPattern[]>(STAGE_DELIMITER_PATTERNS);
  const [stageDelimiterPattern, setStageDelimiterPattern] = useState<ScriptConfigStageDelimiterPattern>("（）");
  const [typeValues, setTypeValues] = useState<string[]>([]);
  const [typeTagMapping, setTypeTagMapping] = useState<TypeTagMapping>({});
  const [tagGroups, setTagGroups] = useState<TagGroupInfo[]>([]);
  const [tagGroupsLoading, setTagGroupsLoading] = useState(false);
  const [tagGroupsError, setTagGroupsError] = useState<string | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const [confirmDeleteOptionId, setConfirmDeleteOptionId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newOptionLabel, setNewOptionLabel] = useState<Record<string, string>>({});
  const [charEntries, setCharEntries] = useState<CharEntry[]>([]);
  const [aggregateMembers, setAggregateMembers] = useState<AggregateMembers>({});
  const [jointPreview, setJointPreview] = useState<JointImportPreview | null>(null);
  const [mappingRows, setMappingRows] = useState<JointImportMappingRow[]>([]);
  const [scriptPreview, setScriptPreview] = useState<ImportScriptPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [pendingCommitConfirmation, setPendingCommitConfirmation] = useState(false);
  const [commitResult, setCommitResult] = useState<{ importedScenes: number; blocksImported: number; charsAdded: number; sceneSummary: SceneSummaryItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function goBack() {
    if (step === "scene-columns") setStep("choose-dramaturgy");
    else if (step === "choose-script") setStep(skipDramaturgy ? "choose-dramaturgy" : "scene-columns");
    else if (step === "script-columns") setStep("choose-script");
    else if (step === "types") setStep("script-columns");
    else if (step === "characters") setStep(typeValues.length > 0 ? "types" : "script-columns");
    else if (step === "aggregates") setStep("characters");
    else if (step === "preview") setStep(aggEntries.length > 0 ? "aggregates" : charEntries.length > 0 ? "characters" : typeValues.length > 0 ? "types" : "script-columns");
  }

  function autoSceneMapping(headers: string[]): Record<string, number | null> {
    const hints: Record<string, string[]> = {
      sceneNum: ["段落编号", "段落号", "章节号", "编号", "序号"],
      sceneName: ["段落名", "章节名", "场景名", "场次名", "场名", "名称", "标题", "场景"],
      intro: ["简介", "内容简介", "内容"],
      actionLine: ["行动线", "动作线"],
      music: ["音乐", "配乐"],
      stagePres: ["舞台呈现", "舞台提示", "舞台说明"],
      duration: ["预期时长", "时长", "预计时长", "time"],
    };
    const next: Record<string, number | null> = { sceneNum: null, sceneName: null, intro: null, actionLine: null, music: null, stagePres: null, duration: null };
    for (const [field, candidates] of Object.entries(hints)) {
      const idx = headers.findIndex(h => {
        const normalized = h.toLowerCase();
        return candidates.some(c => normalized.includes(c.toLowerCase()));
      });
      if (idx >= 0) next[field] = idx;
    }
    return next;
  }

  function autoScriptMapping(headers: string[]): Record<string, number | number[] | null> {
    const hints: Record<string, string[]> = {
      sceneNum: ["段落", "场次", "编号", "段落号"],
      rehearsalMark: ["排练记号", "记号", "提示"],
      typeTag: ["类型", "tag", "标签"],
      character: ["角色", "演员"],
      stageComment: ["演员提示", "补充舞台提示", "舞台提示"],
    };
    const next: Record<string, number | number[] | null> = { sceneNum: null, rehearsalMark: null, typeTag: null, character: null, stageComment: null, bodyColumns: [], stageInlineColumns: [] };
    for (const [field, candidates] of Object.entries(hints)) {
      const idx = headers.findIndex(h => {
        const normalized = h.toLowerCase();
        return candidates.some(c => normalized.includes(c.toLowerCase()));
      });
      if (idx >= 0) next[field] = idx;
    }
    const bodyIdx = headers.findIndex(h => {
      const normalized = h.toLowerCase();
      return ["剧本", "内容", "台词", "文本"].some(c => normalized.includes(c.toLowerCase()));
    });
    if (bodyIdx >= 0) next.bodyColumns = [bodyIdx];
    next.stageInlineColumns = headers.flatMap((header, index) => header.toLowerCase().includes("cue") ? [index] : []);
    return next;
  }

  async function loadSheetData(token: string, sheet: SheetMeta, kind: "dramaturgy" | "script") {
    setLoadingData(true);
    setDataError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/feishu-sheet/${encodeURIComponent(token)}/${encodeURIComponent(sheet.sheetId)}?rowCount=${sheet.rowCount}`);
      const data = await res.json() as { data?: SheetData; error?: string };
      if (!res.ok || data.error) { setDataError(data.error ?? "加载失败"); return; }
      const payload = data.data!;
      if (kind === "dramaturgy") {
        setSkipDramaturgy(false);
        setDramWorkbook(prev => ({ token, sheets: prev?.token === token ? prev.sheets : [sheet] }));
        setDramSheet(sheet);
        setDramData(payload);
        setSceneMapping(autoSceneMapping(payload.headers));
        setJointPreview(null);
        setMappingRows([]);
        setStep("scene-columns");
      } else {
        setScriptWorkbook(prev => ({ token, sheets: prev?.token === token ? prev.sheets : [sheet] }));
        setScriptSheet(sheet);
        setScriptData(payload);
        setScriptMapping(autoScriptMapping(payload.headers));
        setTypeValues([]);
        setTypeTagMapping({});
        setTagGroups([]);
        setTagGroupsError(null);
        setConfirmDeleteGroupId(null);
        setConfirmDeleteOptionId(null);
        setCharEntries([]);
        setAggregateMembers({});
        setScriptPreview(null);
        setCommitResult(null);
        setStep("script-columns");
      }
    } catch {
      setDataError("网络错误");
    } finally {
      setLoadingData(false);
      if (kind === "script") setLoadingScriptOption(null);
    }
  }

  function buildSceneColMap(): SceneColMap | null {
    if (sceneMapping.sceneNum == null) return null;
    return {
      sceneNum: sceneMapping.sceneNum,
      sceneName: sceneMapping.sceneName ?? undefined,
      intro: sceneMapping.intro ?? undefined,
      actionLine: sceneMapping.actionLine ?? undefined,
      music: sceneMapping.music ?? undefined,
      stagePres: sceneMapping.stagePres ?? undefined,
      duration: sceneMapping.duration ?? undefined,
    };
  }
  function buildScriptColMap(): ScriptColMap | null {
    if (scriptMapping.sceneNum == null) return null;
    const bodyColumns = (scriptMapping.bodyColumns as number[] | null) ?? [];
    if (bodyColumns.length === 0) return null;
    return {
      sceneNum: scriptMapping.sceneNum as number,
      rehearsalMark: (scriptMapping.rehearsalMark as number | null) ?? undefined,
      typeTag: (scriptMapping.typeTag as number | null) ?? undefined,
      character: (scriptMapping.character as number | null) ?? undefined,
      stageComment: (scriptMapping.stageComment as number | null) ?? undefined,
      bodyColumns,
      stageInlineColumns: (scriptMapping.stageInlineColumns as number[] | null) ?? undefined,
      stageInlinePatterns: stageInlinePatterns.length > 0 ? stageInlinePatterns : undefined,
    };
  }

  function sheetRowsForColumns(data: SheetData, columns: Array<number | undefined>): (string | null)[][] {
    const selected = [...new Set(columns.filter((col): col is number => col != null))];
    const width = Math.max(-1, ...selected) + 1;
    return [data.rawHeaders, ...data.rows].map(row => {
      const projected = Array<string | null>(width).fill(null);
      for (const col of selected) projected[col] = row[col] ?? null;
      return projected;
    });
  }

  function applyMappingAction(index: number, action: JointImportMappingAction) {
    setMappingRows(rows => {
      if (!rows[index]) return rows;
      const scopeMarker = action === "create" ? rows[index].imported : rows[index].extracted;
      if (scopeMarker?.parentNum) return applySceneScopedMappingAction(rows, index, action);
      return applyChapterScopedMappingAction(rows, index, action);
    });
  }

  function undoMappingGap(index: number, side: "extracted" | "imported") {
    setMappingRows(rows => {
      const row = rows[index];
      if (!row) return rows;
      const scopeMarker = side === "extracted" ? row.imported : row.extracted;
      if (scopeMarker?.parentNum) return undoSceneScopedMappingGap(rows, index, side);
      return undoChapterScopedMappingGap(rows, index, side);
    });
  }

  type ChapterGroup = JointImportMarker[] | null;

  function applyChapterScopedMappingAction(rows: JointImportMappingRow[], index: number, action: JointImportMappingAction): JointImportMappingRow[] {
    const row = rows[index];
    if (!row?.extracted || !row.imported) return rows;
    const grouped = chapterGroups(rows);
    const groupIndex = grouped.findIndex(group => group.start <= index && index < group.end);
    if (groupIndex < 0) return rows;
    const extractedGroups = grouped.map(group => group.extracted);
    const importedGroups = grouped.map(group => group.imported);
    if (action === "create") {
      extractedGroups.splice(groupIndex, 0, null);
      removeNextNullGroup(extractedGroups, groupIndex + 1);
    } else {
      importedGroups.splice(groupIndex, 0, null);
      removeNextNullGroup(importedGroups, groupIndex + 1);
    }
    return reindexRows(buildRowsFromChapterGroups(extractedGroups, importedGroups));
  }

  function undoChapterScopedMappingGap(rows: JointImportMappingRow[], index: number, side: "extracted" | "imported"): JointImportMappingRow[] {
    const grouped = chapterGroups(rows);
    const groupIndex = grouped.findIndex(group => group.start <= index && index < group.end);
    if (groupIndex < 0) return rows;
    const extractedGroups = grouped.map(group => group.extracted);
    const importedGroups = grouped.map(group => group.imported);
    if (side === "extracted") {
      if (extractedGroups[groupIndex] !== null || !importedGroups[groupIndex]) return rows;
      extractedGroups.splice(groupIndex, 1);
    } else {
      if (importedGroups[groupIndex] !== null || !extractedGroups[groupIndex]) return rows;
      importedGroups.splice(groupIndex, 1);
    }
    return reindexRows(buildRowsFromChapterGroups(extractedGroups, importedGroups));
  }

  function applySceneScopedMappingAction(rows: JointImportMappingRow[], index: number, action: JointImportMappingAction): JointImportMappingRow[] {
    const row = rows[index];
    if (!row?.extracted || !row.imported) return rows;
    const segment = sceneScopeSegment(rows, index);
    if (!segment) return rows;
    const localIndex = index - segment.start;
    const extractedColumn = segment.rows.map(item => item.extracted);
    const importedColumn = segment.rows.map(item => item.imported);
    if (action === "create") {
      extractedColumn.splice(localIndex, 0, null);
      removeNextNull(extractedColumn, localIndex + 1);
    } else {
      importedColumn.splice(localIndex, 0, null);
      removeNextNull(importedColumn, localIndex + 1);
    }
    return replaceRowsSegment(rows, segment.start, segment.end, buildSceneScopedRowsFromColumns(extractedColumn, importedColumn));
  }

  function undoSceneScopedMappingGap(rows: JointImportMappingRow[], index: number, side: "extracted" | "imported"): JointImportMappingRow[] {
    const segment = sceneScopeSegment(rows, index);
    if (!segment) return rows;
    const localIndex = index - segment.start;
    const extractedColumn = segment.rows.map(item => item.extracted);
    const importedColumn = segment.rows.map(item => item.imported);
    if (side === "extracted") {
      if (extractedColumn[localIndex] !== null || !importedColumn[localIndex]) return rows;
      extractedColumn.splice(localIndex, 1);
    } else {
      if (importedColumn[localIndex] !== null || !extractedColumn[localIndex]) return rows;
      importedColumn.splice(localIndex, 1);
    }
    return replaceRowsSegment(rows, segment.start, segment.end, buildSceneScopedRowsFromColumns(extractedColumn, importedColumn));
  }

  function canUndoMappingGap(rows: JointImportMappingRow[], index: number, side: "extracted" | "imported"): boolean {
    const row = rows[index];
    if (!row) return false;
    const scopeMarker = side === "extracted" ? row.imported : row.extracted;
    if (!scopeMarker) return false;
    if (!scopeMarker.parentNum) return true;
    const nextRow = rows[index + 1];
    if (!nextRow) return false;
    if (nextRow.extracted?.parentNum !== scopeMarker.parentNum && nextRow.imported?.parentNum !== scopeMarker.parentNum) return false;
    return side === "extracted"
      ? nextRow.extracted !== null
      : nextRow.imported !== null;
  }

  function chapterGroups(rows: JointImportMappingRow[]): Array<{ start: number; end: number; extracted: ChapterGroup; imported: ChapterGroup }> {
    const groups: Array<{ start: number; end: number; extracted: ChapterGroup; imported: ChapterGroup }> = [];
    for (let index = 0; index < rows.length;) {
      const row = rows[index];
      const extractedChapterNum = row.extracted && !row.extracted.parentNum ? row.extracted.num : null;
      const importedChapterNum = row.imported && !row.imported.parentNum ? row.imported.num : null;
      let end = index + 1;
      while (end < rows.length && (
        (!!extractedChapterNum && rows[end].extracted?.parentNum === extractedChapterNum)
        || (!!importedChapterNum && rows[end].imported?.parentNum === importedChapterNum)
      )) {
        end++;
      }
      const segment = rows.slice(index, end);
      const extracted = segment.map(item => item.extracted).filter((marker): marker is JointImportMarker => !!marker);
      const imported = segment.map(item => item.imported).filter((marker): marker is JointImportMarker => !!marker);
      groups.push({
        start: index,
        end,
        extracted: extracted.length > 0 ? extracted : null,
        imported: imported.length > 0 ? imported : null,
      });
      index = end;
    }
    return groups;
  }

  function buildRowsFromChapterGroups(extractedGroups: ChapterGroup[], importedGroups: ChapterGroup[]): JointImportMappingRow[] {
    const rows: JointImportMappingRow[] = [];
    const length = Math.max(extractedGroups.length, importedGroups.length);
    for (let groupIndex = 0; groupIndex < length; groupIndex++) {
      const extractedGroup = extractedGroups[groupIndex];
      const importedGroup = importedGroups[groupIndex];
      const groupLength = Math.max(extractedGroup?.length ?? 0, importedGroup?.length ?? 0);
      for (let markerIndex = 0; markerIndex < groupLength; markerIndex++) {
        const extracted = extractedGroup?.[markerIndex] ?? null;
        const imported = importedGroup?.[markerIndex] ?? null;
        if (!extracted && !imported) continue;
        rows.push({
          id: "",
          extracted,
          imported,
        });
      }
    }
    return rows;
  }

  function removeNextNullGroup(groups: ChapterGroup[], startIndex: number) {
    const index = groups.findIndex((group, groupIndex) => groupIndex >= startIndex && group === null);
    if (index >= 0) groups.splice(index, 1);
  }

  function sceneScopeSegment(rows: JointImportMappingRow[], index: number): { start: number; end: number; rows: JointImportMappingRow[] } | null {
    const row = rows[index];
    const rowExtractedParentNum = row?.extracted?.parentNum ?? null;
    const rowImportedParentNum = row?.imported?.parentNum ?? null;
    const extractedParentNum = rowExtractedParentNum ?? rowImportedParentNum;
    const importedParentNum = rowImportedParentNum ?? rowExtractedParentNum;
    if (!extractedParentNum && !importedParentNum) return null;
    const inScope = (item: JointImportMappingRow) => (
      (!!extractedParentNum && item.extracted?.parentNum === extractedParentNum)
      || (!!importedParentNum && item.imported?.parentNum === importedParentNum)
    );
    let start = index;
    while (start > 0 && inScope(rows[start - 1])) start--;
    let end = index + 1;
    while (end < rows.length && inScope(rows[end])) end++;
    return { start, end, rows: rows.slice(start, end) };
  }

  function buildSceneScopedRowsFromColumns(extractedColumn: Array<JointImportMarker | null>, importedColumn: Array<JointImportMarker | null>): JointImportMappingRow[] {
    const rows: JointImportMappingRow[] = [];
    const length = Math.max(extractedColumn.length, importedColumn.length);
    for (let index = 0; index < length; index++) {
      const extracted = extractedColumn[index] ?? null;
      const imported = importedColumn[index] ?? null;
      if (!extracted && !imported) continue;
      rows.push({
        id: `row:${rows.length}:l-${extracted?.num ?? "na"}:r-${imported?.num ?? "na"}`,
        extracted,
        imported,
      });
    }
    return rows;
  }

  function replaceRowsSegment(rows: JointImportMappingRow[], start: number, end: number, replacement: JointImportMappingRow[]): JointImportMappingRow[] {
    return reindexRows([
      ...rows.slice(0, start),
      ...replacement,
      ...rows.slice(end),
    ]);
  }

  function reindexRows(rows: JointImportMappingRow[]): JointImportMappingRow[] {
    return rows.map((row, index) => ({
      ...row,
      id: `row:${index}:l-${row.extracted?.num ?? "na"}:r-${row.imported?.num ?? "na"}`,
    }));
  }

  function removeNextNull(column: Array<JointImportMarker | null>, startIndex: number) {
    for (let index = startIndex; index < column.length;) {
      if (column[index] === null) {
        column.splice(index, 1);
        return;
      }
      index++;
    }
  }

  function buildFinalImportMarkers(rows: JointImportMappingRow[]): Array<{ rowIndex: number; marker: JointImportMarker }> {
    const finalRows: Array<{ rowIndex: number; marker: JointImportMarker }> = [];
    const compactRows = rows.filter(row => row?.extracted || row?.imported);
    const seen = new Set<string>();
    let nextGeneratedChapterIndex = 0;
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
        name: row.imported?.name || row.extracted?.name || source.name,
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

  function markerLabel(marker: JointImportMarker | null) {
    if (!marker) return <span className="text-gray-300">N/A</span>;
    if (marker.parentNum) return <span>{marker.name ? `${marker.num} ${marker.name}` : marker.num}</span>;
    return (
      <span>
        <strong>{marker.num}</strong>{marker.name ? ` ${marker.name}` : ""}
      </span>
    );
  }

  function markerLabelWithSuffix(marker: JointImportMarker | null, suffix: string, suffixClassName: string) {
    const suffixNode = suffix ? <span className={suffixClassName}>{suffix}</span> : null;
    if (!marker) return <span className="text-gray-300">N/A</span>;
    if (marker.parentNum) return <span>{marker.name ? `${marker.num} ${marker.name}` : marker.num}{suffixNode}</span>;
    return (
      <span>
        <strong>{marker.num}</strong>{marker.name ? ` ${marker.name}` : ""}{suffixNode}
      </span>
    );
  }

  function hasMarkerDetails(marker: JointImportMarker | null): boolean {
    return !!(marker?.synopsis || marker?.actionLine || marker?.music || marker?.stageNotes || marker?.expectedDuration);
  }

  function markerDetailsUpdateLabel(marker: JointImportMarker | null): string {
    return marker?.parentNum ? "段落详情将更新" : "章节详情将更新";
  }

  async function runPreview() {
    const sceneColMap = buildSceneColMap();
    const scriptColMap = buildScriptColMap();
    if (!scriptColMap || !scriptSheet || !scriptWorkbook || !scriptData) return;
    if (!skipDramaturgy && (!sceneColMap || !dramSheet || !dramWorkbook || !dramData)) return;
    setPreviewLoading(true);
    setError(null);
    const characterKinds: Record<string, "normal" | "aggregate"> = {};
    for (const e of charEntries) characterKinds[effectiveName(e)] = e.kind;
    try {
      const scriptPreviewRows = sheetRowsForColumns(scriptData, [
        scriptColMap.sceneNum,
        scriptColMap.rehearsalMark,
        scriptColMap.typeTag,
        scriptColMap.character,
        scriptColMap.stageComment,
        ...scriptColMap.bodyColumns,
        ...(scriptColMap.stageInlineColumns ?? []),
      ]);
      const versionQuery = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
      const jointRequest = fetch(`${BASE_PATH}/api/production/${productionId}/import-joint${versionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dramaturgy: skipDramaturgy ? null : {
              spreadsheetToken: dramWorkbook!.token,
              sheetId: dramSheet!.sheetId,
              rowCount: dramSheet!.rowCount,
              colMap: sceneColMap,
              headerRowIncluded: hasSceneHeader,
              rows: sheetRowsForColumns(dramData!, Object.values(sceneColMap!)),
            },
            script: {
              spreadsheetToken: scriptWorkbook.token,
              sheetId: scriptSheet.sheetId,
              rowCount: scriptSheet.rowCount,
              colMap: scriptColMap,
              headerRowIncluded: hasScriptHeader,
              rows: sheetRowsForColumns(scriptData, [scriptColMap.sceneNum]),
            },
          }),
        });
      const [jointRes, scriptRes] = await Promise.all([
        jointRequest,
        fetch(`${BASE_PATH}/api/production/${productionId}/import-script${versionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spreadsheetToken: scriptWorkbook.token,
            sheetId: scriptSheet.sheetId,
            rowCount: scriptSheet.rowCount,
            colMap: scriptColMap,
            stageDelimiterPattern,
            typeTagMapping,
            characterKinds,
            headerRowIncluded: hasScriptHeader,
            rows: scriptPreviewRows,
          }),
        }),
      ]);
      const jointData = await readApiResult<{ preview?: JointImportPreview }>(jointRes, "构作映射预览失败");
      const scriptPreviewData = await readApiResult<{ preview?: ImportScriptPreview }>(scriptRes, "剧本预览失败");
      if (!jointRes.ok || jointData.error) { setError(jointData.error ?? "构作映射预览失败"); return; }
      if (!scriptRes.ok || scriptPreviewData.error) { setError(scriptPreviewData.error ?? "剧本预览失败"); return; }
      setJointPreview(jointData.preview!);
      setMappingRows(jointData.preview!.mappingRows);
      setScriptPreview(scriptPreviewData.preview!);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommit() {
    const sceneColMap = buildSceneColMap();
    const scriptColMap = buildScriptColMap();
    if (!scriptColMap || !scriptSheet || !scriptWorkbook) return;
    if (!skipDramaturgy && (!sceneColMap || !dramSheet || !dramWorkbook)) return;
    setPendingCommitConfirmation(true);
  }

  async function commitImport() {
    const scriptColMap = buildScriptColMap();
    if (!scriptColMap || !scriptSheet || !scriptWorkbook) return;
    setCommitLoading(true);
    setError(null);
    const characterKinds: Record<string, "normal" | "aggregate"> = {};
    for (const e of charEntries) characterKinds[effectiveName(e)] = e.kind;
    try {
      const sceneOverrides = buildFinalImportMarkers(mappingRows).map(item => item.marker);
      if (sceneOverrides.length === 0) {
        setError("没有可导入的构作");
        return;
      }

      const scriptRes = await fetch(`${BASE_PATH}/api/production/${productionId}/import-script${versionId ? `?v=${encodeURIComponent(versionId)}` : ""}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetToken: scriptWorkbook.token,
          sheetId: scriptSheet.sheetId,
          rowCount: scriptSheet.rowCount,
          colMap: scriptColMap,
          stageDelimiterPattern,
          typeTagMapping,
          characterKinds,
          aggregateMembers,
          headerRowIncluded: hasScriptHeader,
          sceneOverrides,
        }),
      });
      const scriptData = await readApiResult<{ blocksImported?: number; charsAdded?: number; sceneSummary?: SceneSummaryItem[] }>(scriptRes, "剧本导入失败");
      if (!scriptRes.ok || scriptData.error) { setError(scriptData.error ?? "剧本导入失败"); return; }
      setCommitResult({
        importedScenes: sceneOverrides.length,
        blocksImported: scriptData.blocksImported!,
        charsAdded: scriptData.charsAdded!,
        sceneSummary: scriptData.sceneSummary ?? [],
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setCommitLoading(false);
    }
  }

  function gotoScriptTypes() {
    const bodyColumns = (scriptMapping.bodyColumns as number[] | null) ?? [];
    if (bodyColumns.length === 0) {
      setError("“剧本内容”不可为空，请选择作为剧本内容导入的字段（表格列）。");
      return;
    }
    setError(null);
    const typeCol = scriptMapping.typeTag as number | null;
    if (typeCol == null || !scriptData) {
      gotoCharacters();
      return;
    }
    const vals = new Set<string>([""]);
    for (const row of scriptData.rows) {
      const v = String(row[typeCol] ?? "").trim();
      if (!v) continue;
      for (const part of splitCellValues(v)) vals.add(part);
    }
    const next = [...vals];
    setTypeValues(next);
    setTypeTagMapping(prev => {
      const out = { ...prev };
      for (const v of next) if (!out[v]) out[v] = { action: "mapType", blockType: "dialogue" };
      return out;
    });
    setTagGroupsLoading(true);
    fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups`)
      .then(async r => {
        const data = await readApiResult<{ groups?: TagGroupInfo[] }>(r, "加载 Tag 组失败");
        if (!r.ok || data.error) throw new Error(data.error ?? "加载 Tag 组失败");
        setTagGroups(data.groups ?? []);
        setTagGroupsError(null);
      })
      .catch(err => {
        setTagGroups([]);
        setTagGroupsError(err instanceof Error ? err.message : "加载 Tag 组失败");
      })
      .finally(() => setTagGroupsLoading(false));
    setStep("types");
  }

  async function createTagGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: "exclusive" }),
      });
      const data = await readApiResult<{ group?: TagGroupInfo }>(res, "创建 Tag 组失败");
      if (!res.ok || data.error) throw new Error(data.error ?? "创建 Tag 组失败");
      if (data.group) {
        setTagGroups(groups => [...groups, { ...data.group!, options: [] }]);
        setNewGroupName("");
        setTagGroupsError(null);
      }
    } catch (err) {
      setTagGroupsError(err instanceof Error ? err.message : "创建 Tag 组失败");
    }
  }

  async function addTagOption(groupId: string) {
    const label = (newOptionLabel[groupId] ?? "").trim();
    if (!label) return;
    const option = await createTagOption(groupId, label);
    if (option) setNewOptionLabel(labels => ({ ...labels, [groupId]: "" }));
  }

  async function createTagOption(groupId: string, label: string): Promise<TagGroupInfo["options"][number] | null> {
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups/${groupId}/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, color: "#a1a1aa", sortOrder: 0 }),
      });
      const data = await readApiResult<{ option?: TagGroupInfo["options"][number] }>(res, "创建 Tag 选项失败");
      if (!res.ok || data.error) throw new Error(data.error ?? "创建 Tag 选项失败");
      if (data.option) {
        setTagGroups(groups => groups.map(group => (
          group.id === groupId ? { ...group, options: [...group.options, data.option!] } : group
        )));
        setTagGroupsError(null);
        return data.option;
      }
    } catch (err) {
      setTagGroupsError(err instanceof Error ? err.message : "创建 Tag 选项失败");
    }
    return null;
  }

  function setRawPrimaryAction(rawValue: string, nextPrimary: TypeAction) {
    setTypeTagMapping(mapping => {
      const tags = tagActions(mapping[rawValue]);
      return { ...mapping, [rawValue]: [nextPrimary, ...tags] };
    });
  }

  async function toggleRawTagInGroup(rawValue: string, group: TagGroupInfo) {
    if (tagActions(typeTagMapping[rawValue]).some(action => action.groupId === group.id)) {
      setTypeTagMapping(mapping => {
        const primary = primaryTypeAction(mapping[rawValue]);
        const tags = tagActions(mapping[rawValue]).filter(action => action.groupId !== group.id);
        return { ...mapping, [rawValue]: [primary, ...tags] };
      });
      return;
    }
    const option = group.options.find(item => item.label === rawValue) ?? await createTagOption(group.id, rawValue);
    if (!option) return;
    setTypeTagMapping(mapping => {
      const primary = primaryTypeAction(mapping[rawValue]);
      const tags = tagActions(mapping[rawValue]).filter(action => action.groupId !== group.id);
      return { ...mapping, [rawValue]: [primary, ...tags, { action: "mapTag", groupId: group.id, optionId: option.id }] };
    });
  }

  async function deleteTagGroupFromImport(groupId: string) {
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups/${groupId}`, { method: "DELETE" });
      const data = await readApiResult<{ ok?: boolean }>(res, "删除 Tag 组失败");
      if (!res.ok || data.error) throw new Error(data.error ?? "删除 Tag 组失败");
      setTagGroups(groups => groups.filter(group => group.id !== groupId));
      setTypeTagMapping(mapping => {
        const next: TypeTagMapping = {};
        for (const [rawValue, action] of Object.entries(mapping)) {
          const primary = primaryTypeAction(action);
          const tags = tagActions(action).filter(item => item.groupId !== groupId);
          next[rawValue] = [primary, ...tags];
        }
        return next;
      });
      setConfirmDeleteGroupId(null);
      setConfirmDeleteOptionId(null);
      setTagGroupsError(null);
    } catch (err) {
      setTagGroupsError(err instanceof Error ? err.message : "删除 Tag 组失败");
    }
  }

  async function deleteTagOptionFromImport(groupId: string, optionId: string) {
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups/${groupId}/options/${optionId}`, { method: "DELETE" });
      const data = await readApiResult<{ ok?: boolean }>(res, "删除 Tag 选项失败");
      if (!res.ok || data.error) throw new Error(data.error ?? "删除 Tag 选项失败");
      setTagGroups(groups => groups.map(group => (
        group.id === groupId
          ? { ...group, options: group.options.filter(option => option.id !== optionId) }
          : group
      )));
      setTypeTagMapping(mapping => {
        const next: TypeTagMapping = {};
        for (const [rawValue, action] of Object.entries(mapping)) {
          const primary = primaryTypeAction(action);
          const tags = tagActions(action).filter(item => item.groupId !== groupId || item.optionId !== optionId);
          next[rawValue] = [primary, ...tags];
        }
        return next;
      });
      setConfirmDeleteOptionId(null);
      setTagGroupsError(null);
    } catch (err) {
      setTagGroupsError(err instanceof Error ? err.message : "删除 Tag 选项失败");
    }
  }

  function gotoCharacters() {
    const charCol = scriptMapping.character as number | null;
    if (charCol == null || !scriptData) {
      runPreview();
      return;
    }
    const seen = new Map<string, CharEntry>();
    for (const row of scriptData.rows) {
      const v = row[charCol];
      if (!v?.trim()) continue;
      for (const part of v.split(/[,，\n]+/)) {
        const raw = part.trim();
        if (!raw || seen.has(raw)) continue;
        const { name: parsedBase, note: parsedSuffix } = parseCharName(raw);
        seen.set(raw, { raw, parsedBase, parsedSuffix, mergeAsNote: parsedSuffix !== null, kind: guessAgg(parsedBase) ? "aggregate" : "normal" });
      }
    }
    setCharEntries([...seen.values()]);
    setStep("characters");
  }

  function gotoAggregates() {
    if (!charEntries.some(entry => entry.kind === "aggregate")) {
      runPreview();
      return;
    }
    setAggregateMembers(prev => {
      const next = { ...prev };
      for (const entry of charEntries) {
        const name = effectiveName(entry);
        if (entry.kind === "aggregate" && !next[name]) next[name] = [];
      }
      return next;
    });
    setStep("aggregates");
  }

  const uniqueByName = new Map<string, CharEntry>();
  for (const e of charEntries) uniqueByName.set(effectiveName(e), e);
  const aggEntries = [...uniqueByName.values()].filter(e => e.kind === "aggregate");
  const normalEntries = [...uniqueByName.values()].filter(e => e.kind !== "aggregate");
  const displayMappingRows = mappingRows
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .filter((item): item is { row: JointImportMappingRow; sourceIndex: number } => !!(item.row?.extracted || item.row?.imported));
  const compactMappingRows = displayMappingRows.map(item => item.row);
  const hasMappedScenes = compactMappingRows.some(row => row.extracted?.parentNum || row.imported?.parentNum);
  const showMappingControls = !skipDramaturgy;
  const finalImportMarkers = buildFinalImportMarkers(compactMappingRows);
  const preserveDisplayMarkers = showMappingControls ? new Map(finalImportMarkers.map(item => [item.rowIndex, item.marker])) : null;
  const rawTypeValues = typeValues.filter(Boolean);
  const selectedTagGroupIdsByRawValue = new Map(rawTypeValues.map(value => [
    value,
    new Set(tagActions(typeTagMapping[value]).map(action => action.groupId)),
  ]));
  const usedRawTypeValues = new Set(rawTypeValues.filter(value => (selectedTagGroupIdsByRawValue.get(value)?.size ?? 0) > 0));

  const stepLabels: Record<Step, string> = {
    "choose-dramaturgy": "导入构作",
    "choose-script": "导入剧本",
    "scene-columns": "构作配置",
    "script-columns": "剧本配置",
    types: "类型映射",
    characters: "角色类型",
    aggregates: "聚合角色",
    preview: "确认",
    done: "完成",
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-bold">导入</h1>
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">本次导入将会覆盖既有的构作和剧本内容。</p>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {(["choose-dramaturgy", "scene-columns", "choose-script", "script-columns", "types", "characters", "aggregates", "preview", "done"] as Step[]).map((s, i, arr) => (
          <span key={s} className={`${s === step ? "text-blue-600 font-semibold" : arr.indexOf(step) > i ? "text-green-600" : "text-gray-400"}`}>
            {i > 0 && <span className="text-gray-300 mx-0.5">→</span>}{stepLabels[s]}
          </span>
        ))}
      </div>

      {step === "choose-dramaturgy" && (
        <div className="space-y-4">
          <p className="text-sm leading-6 text-gray-700">请选择剧本构作（Dramaturgy）所在的飞书表格。<br />如点击“跳过”则不进行任何外源导入，直接通过后续剧本中的章节分割自动生成剧本构作。</p>
          <SheetPicker
            onLoaded={(token, sheets, url) => {
              setDramWorkbook({ token, sheets });
              setDramWorkbookUrl(url);
            }}
            onSelect={(token, sheet) => loadSheetData(token, sheet, "dramaturgy")}
            disabled={loadingData}
            beforeLoadButton={
              <button
                onClick={() => {
                  setSkipDramaturgy(true);
                  setDramWorkbook(null);
                  setDramWorkbookUrl("");
                  setDramSheet(null);
                  setDramData(null);
                  setJointPreview(null);
                  setMappingRows([]);
                  setStep("choose-script");
                }}
                disabled={loadingData}
                className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50 disabled:opacity-50 disabled:hover:bg-white"
              >
                跳过
              </button>
            }
          />
        </div>
      )}

      {step === "choose-script" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-700">请输入剧本所在的飞书表格链接。</p>
          {skipDramaturgy && <p className="text-sm text-gray-700">【剧本构作】将直接根据剧本内容中的章节段落生成。</p>}
          <div className="space-y-4">
            <SheetPicker
              key={scriptPickerPreset?.nonce ?? "script-picker"}
              initialUrl={scriptPickerPreset?.url ?? ""}
              initialSpreadsheetToken={scriptPickerPreset?.token ?? null}
              initialSheets={scriptPickerPreset?.sheets}
              onLoaded={(token, sheets, url) => {
                setScriptWorkbook({ token, sheets });
                setScriptPickerPreset(prev => prev ? { url, token, sheets, nonce: prev.nonce } : prev);
              }}
              onSelect={(token, sheet) => loadSheetData(token, sheet, "script")}
              disabled={loadingData}
              beforeLoadButton={!skipDramaturgy && (
                <button
                  onClick={() => {
                    if (!dramWorkbook || !dramWorkbookUrl) return;
                    setScriptWorkbook(dramWorkbook);
                    setScriptPickerPreset({ url: dramWorkbookUrl, token: dramWorkbook.token, sheets: dramWorkbook.sheets, nonce: Date.now() });
                    if (dramWorkbook.sheets.length === 1) {
                      const sheet = dramWorkbook.sheets[0];
                      setLoadingScriptOption("reuse");
                      loadSheetData(dramWorkbook.token, sheet, "script");
                    }
                  }}
                  disabled={loadingData || !dramWorkbook || !dramWorkbookUrl}
                  className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50 disabled:opacity-50 disabled:hover:bg-white"
                >
                  {loadingScriptOption === "reuse" ? "加载中..." : "沿用构作链接"}
                </button>
              )}
            />
          </div>
          {dataError && <p className="text-sm text-red-600">{dataError}</p>}
          <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">
            上一步
          </button>
        </div>
      )}

      {step === "scene-columns" && dramData && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">表格: {dramSheet?.title}</span>
            <button onClick={() => setStep("choose-dramaturgy")} className="text-xs text-blue-600 hover:underline">重新选择</button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="hasSceneHeader"
              checked={hasSceneHeader}
              onChange={e => setHasSceneHeader(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="hasSceneHeader" className="text-sm text-gray-700">第一行是表头（已自动跳过）</label>
          </div>

          <ColumnMapper sheetData={dramData} columns={[
            { key: "sceneNum", label: "段落编号", required: true },
            { key: "sceneName", label: "段落名（可选）" },
            { key: "intro", label: "简介（可选）" },
            { key: "actionLine", label: "行动线（可选）" },
            { key: "music", label: "音乐（可选）" },
            { key: "stagePres", label: "舞台呈现（可选）" },
            { key: "duration", label: "预期时长（可选）" },
          ]} mapping={sceneMapping as Record<string, number | number[] | null>} onChange={(k, v) => setSceneMapping(m => ({ ...m, [k]: v as number | null }))} showPreview />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button
              onClick={() => setStep("choose-script")}
              disabled={sceneMapping.sceneNum == null}
              className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              下一步：导入剧本
            </button>
          </div>
        </div>
      )}

      {step === "script-columns" && scriptData && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">表格: {scriptSheet?.title}</span>
            <button onClick={() => setStep("choose-script")} className="text-xs text-blue-600 hover:underline">重新选择</button>
            {skipDramaturgy && <span className="text-xs text-gray-500">【剧本构作】将直接根据剧本内容中的章节段落生成</span>}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="hasScriptHeader"
              checked={hasScriptHeader}
              onChange={e => setHasScriptHeader(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="hasScriptHeader" className="text-sm text-gray-700">第一行是表头（已自动跳过）</label>
          </div>

          <ColumnMapper sheetData={scriptData} columns={[
            { key: "sceneNum", label: "段落", required: true },
            { key: "character", label: "角色" },
            { key: "stageComment", label: "演员提示" },
            { key: "bodyColumns", label: "剧本内容", required: true, multi: true },
            { key: "rehearsalMark", label: "排练记号" },
            { key: "typeTag", label: "类型/Tag" },
            { key: "stageInlineColumns", label: "内嵌舞台提示列", multi: true },
          ]} mapping={scriptMapping} onChange={(k, v) => setScriptMapping(m => ({ ...m, [k]: v }))} showPreview />
          <div className="rounded border border-gray-200 p-3 space-y-2">
            <p className="text-sm font-medium text-gray-700">段内舞台提示识别</p>
            <div className="space-y-3 text-sm">
              <div className="space-y-1.5">
                <p className="text-gray-500">将原剧本中用于标记段内舞台提示使用的括号</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {STAGE_DELIMITER_PATTERNS.map(pat => (
                    <label key={pat} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={stageInlinePatterns.includes(pat)}
                        onChange={e => setStageInlinePatterns(ps => e.target.checked ? [...ps, pat] : ps.filter(p => p !== pat))}
                        className="rounded"
                      />
                      <code className="text-xs bg-gray-100 px-1 rounded">{pat}</code>
                    </label>
                  ))}
                  <button
                    type="button"
                    onClick={() => setStageInlinePatterns(STAGE_DELIMITER_PATTERNS)}
                    disabled={stageInlinePatterns.length === STAGE_DELIMITER_PATTERNS.length}
                    className="text-xs text-blue-600 hover:underline disabled:text-gray-300 disabled:no-underline"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setStageInlinePatterns([])}
                    disabled={stageInlinePatterns.length === 0}
                    className="text-xs text-zinc-500 hover:underline disabled:text-gray-300 disabled:no-underline"
                  >
                    清空
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-gray-500">统一替换为：</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {SCRIPT_CONFIG_STAGE_DELIMITER_PATTERNS.map(pat => (
                    <label key={pat} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="stage-delimiter-pattern"
                        checked={stageDelimiterPattern === pat}
                        onChange={() => setStageDelimiterPattern(pat)}
                      />
                      <code className="text-xs bg-gray-100 px-1 rounded">{pat}</code>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={gotoScriptTypes} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">下一步：类型映射</button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {step === "types" && (
        <div className="space-y-4">
          <div className="rounded border border-gray-200 p-3 space-y-3">
            <p className="text-sm font-medium text-gray-700">Tag 组{tagGroupsLoading ? "（加载中...）" : ""}</p>
            {tagGroupsError && <p className="text-xs text-red-600">{tagGroupsError}</p>}
            {rawTypeValues.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-gray-500">剧本中既有的全部类型标签：</span>
                {rawTypeValues.map(value => {
                  const used = usedRawTypeValues.has(value);
                  return (
                    <span
                      key={value}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        used
                          ? "border-violet-900/20 bg-violet-900/10 text-gray-700"
                          : "border-gray-200 bg-white text-gray-700"
                      }`}
                    >
                      {value}
                    </span>
                  );
                })}
              </div>
            )}
            <div>
              {tagGroups.map(group => (
                <div key={group.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="rounded border border-gray-100 bg-gray-50/60 p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-gray-700">{group.name}</p>
                      {confirmDeleteGroupId === group.id ? (
                        <span className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => deleteTagGroupFromImport(group.id)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            确认删除该组
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteGroupId(null)}
                            className="text-xs text-zinc-400 hover:text-zinc-600"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteGroupId(group.id)}
                          className="text-sm leading-none text-zinc-400 hover:text-zinc-700"
                          aria-label={`删除 Tag 组 ${group.name}`}
                          title="删除"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {rawTypeValues.map(rawValue => {
                        const selected = selectedTagGroupIdsByRawValue.get(rawValue)?.has(group.id) ?? false;
                        return (
                          <button
                            key={rawValue}
                            type="button"
                            onClick={() => void toggleRawTagInGroup(rawValue, group)}
                            className={`px-2 py-0.5 rounded text-xs border ${
                              selected
                                ? "bg-violet-900/60 text-white border-violet-900/60 hover:bg-violet-900/80"
                                : "bg-white text-gray-600 border-gray-200 hover:border-violet-300"
                            }`}
                          >
                            {rawValue}
                          </button>
                        );
                      })}
                      {group.options
                        .filter(option => !rawTypeValues.includes(option.label))
                        .map(option => (
                          confirmDeleteOptionId === option.id ? (
                            <span key={option.id} className="inline-flex items-center gap-1.5 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-xs">
                              <span className="text-red-700">{option.label}</span>
                              <button
                                type="button"
                                onClick={() => deleteTagOptionFromImport(group.id, option.id)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteOptionId(null)}
                                className="text-xs text-zinc-400 hover:text-zinc-600"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => setConfirmDeleteOptionId(option.id)}
                              className="px-2 py-0.5 rounded text-xs border bg-violet-900/60 text-white border-violet-900/60 hover:bg-violet-900/80"
                            >
                              {option.label}
                            </button>
                          )
                        ))}
                      <div className="flex gap-1">
                        <input
                          type="text"
                          placeholder="新选项"
                          value={newOptionLabel[group.id] ?? ""}
                          onChange={e => setNewOptionLabel(labels => ({ ...labels, [group.id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Enter") addTagOption(group.id); }}
                          className="border border-gray-200 rounded px-1.5 py-0.5 text-xs w-20 focus:outline-none focus:border-violet-400"
                        />
                        <button onClick={() => addTagOption(group.id)} className="px-1.5 py-0.5 text-xs bg-violet-900/10 rounded hover:bg-violet-200">+</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 items-center border-t border-gray-100 pt-3">
              <input
                type="text"
                placeholder="新建 Tag 组名称"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createTagGroup(); }}
                className="border border-gray-200 rounded px-2 py-1 text-xs w-40 focus:outline-none focus:border-blue-400"
              />
              <button onClick={createTagGroup} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-800">创建</button>
            </div>
          </div>

          <p className="text-sm font-medium text-gray-700">类型映射</p>
          {typeValues.map(val => {
            const action = primaryTypeAction(typeTagMapping[val]);
            const activeTags = tagActions(typeTagMapping[val]);
            return (
              <div key={val} className="flex items-center gap-2 flex-wrap">
                <span className="w-28 text-sm font-medium truncate">{val || <span className="text-gray-400 italic">空白</span>}</span>
                <select className="border border-gray-300 rounded px-2 py-1 text-sm"
                  value={activeTags.length > 0 ? "mapTag" : action.action}
                  onChange={e => {
                    const a = e.target.value as TypeAction["action"];
                    if (a !== "mapTag") setRawPrimaryAction(val, a === "ignore" ? { action: "ignore" } : { action: "mapType", blockType: "dialogue" });
                  }}>
                  <option value="mapType">映射到类型</option>
                  <option value="mapTag">映射到 Tag</option>
                  <option value="ignore">忽略该行</option>
                </select>
                {action.action === "mapType" && activeTags.length === 0 && <select className="border border-gray-300 rounded px-2 py-1 text-sm" value={(action as { action: "mapType"; blockType: string }).blockType} onChange={e => setRawPrimaryAction(val, { action: "mapType", blockType: e.target.value as "dialogue" | "stage" | "lyric" | "marker" })}>{Object.entries(BLOCK_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
                {activeTags.map(ta => {
                  const grp = tagGroups.find(g => g.id === ta.groupId);
                  const opt = grp?.options.find(o => o.id === ta.optionId);
                  if (!grp) return null;
                  return (
                    <span key={ta.groupId + ta.optionId} className="inline-flex items-center gap-1 rounded border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs text-violet-700">
                      {grp.name}{opt ? `/${opt.label}` : ""}
                      <button type="button" onClick={() => void toggleRawTagInGroup(val, grp)} className="ml-0.5 hover:text-red-500 leading-none">×</button>
                    </span>
                  );
                })}
                {val && tagGroups.filter(g => !activeTags.some(ta => ta.groupId === g.id)).length > 0 && (
                  <select
                    className="rounded border border-dashed border-violet-300 bg-white px-1.5 py-0.5 text-xs text-violet-400"
                    value=""
                    onChange={e => {
                      const grp = tagGroups.find(g => g.id === e.target.value);
                      if (grp) void toggleRawTagInGroup(val, grp);
                    }}
                  >
                    <option value="">+ Tag</option>
                    {tagGroups
                      .filter(g => !activeTags.some(ta => ta.groupId === g.id))
                      .map(g => <option key={g.id} value={g.id}>{g.name}</option>)
                    }
                  </select>
                )}
              </div>
            );
          })}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={gotoCharacters} disabled={previewLoading} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">{previewLoading ? "加载中..." : "下一步：角色类型"}</button>
          </div>
        </div>
      )}

      {step === "characters" && (
        <div className="space-y-4">
          <div className="rounded border border-gray-200 overflow-hidden text-sm">
            <table className="w-full"><thead className="bg-gray-50"><tr className="text-left text-xs text-gray-500"><th className="px-3 py-2 font-medium">原始值</th><th className="px-3 py-2 font-medium">处理方式</th><th className="px-3 py-2 font-medium">角色名</th><th className="px-3 py-2 font-medium">聚合角色</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {charEntries.map((entry, idx) => (
                  <tr key={entry.raw}>
                    <td className="px-3 py-1.5 text-gray-400 text-xs font-mono">{entry.raw}</td>
                    <td className="px-3 py-1.5">{entry.parsedSuffix !== null ? <div className="flex gap-1"><button onClick={() => setCharEntries(es => es.map((x, i) => i === idx ? { ...x, mergeAsNote: false } : x))} className={`px-2 py-0.5 rounded text-xs border ${!entry.mergeAsNote ? "bg-gray-800 text-white border-gray-800" : "border-gray-200 text-gray-500"}`}>新角色</button><button onClick={() => setCharEntries(es => es.map((x, i) => i === idx ? { ...x, mergeAsNote: true } : x))} className={`px-2 py-0.5 rounded text-xs border ${entry.mergeAsNote ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-500"}`}>备注→{entry.parsedBase}</button></div> : <span className="text-xs text-gray-400">—</span>}</td>
                    <td className="px-3 py-1.5 text-sm">{effectiveName(entry)}</td>
                    <td className="px-3 py-1.5"><input type="checkbox" checked={entry.kind === "aggregate"} onChange={e => setCharEntries(es => es.map((x, i) => i === idx ? { ...x, kind: e.target.checked ? "aggregate" : "normal" } : x))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={gotoAggregates} disabled={previewLoading} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">{previewLoading ? "加载中..." : aggEntries.length > 0 ? "下一步：聚合角色" : "下一步：确认"}</button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {step === "aggregates" && (
        <div className="space-y-4">
          {aggEntries.map(agg => {
            const aggName = effectiveName(agg);
            return <div key={aggName} className="rounded border border-gray-200 p-3 space-y-2"><p className="font-medium text-sm">{aggName}</p><div className="flex flex-wrap gap-2">{normalEntries.map(m => { const mName = effectiveName(m); const selected = (aggregateMembers[aggName] ?? []).includes(mName); return <button key={mName} onClick={() => setAggregateMembers(prev => { const cur = prev[aggName] ?? []; return { ...prev, [aggName]: selected ? cur.filter(n => n !== mName) : [...cur, mName] }; })} className={`px-2 py-0.5 rounded text-sm border ${selected ? "bg-violet-900/60 text-white border-violet-900/60" : "border-gray-200 text-gray-600"}`}>{mName}</button>; })}</div></div>;
          })}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={runPreview} disabled={previewLoading} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">{previewLoading ? "加载中..." : "下一步：确认"}</button>
          </div>
        </div>
      )}

      {step === "preview" && scriptPreview && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3 text-center text-sm">
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-purple-600">{mappingRows.length}</div>
              <div className="text-gray-500">构作段落</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-blue-600">{scriptPreview.blockCount}</div>
              <div className="text-gray-500">剧本行</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-green-600">{scriptPreview.charsToAdd.length}</div>
              <div className="text-gray-500">新增角色</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-amber-600">{scriptPreview.charConflicts.length}</div>
              <div className="text-gray-500">角色冲突</div>
            </div>
          </div>
          {jointPreview && (
            <div className="rounded border border-gray-200 p-3 text-sm space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-700 mb-1">构作映射</p>
                  <p className="text-gray-600">
                    剧本构作 {jointPreview.extractedMarkers.length}，导入构作 {jointPreview.importedMarkers.length}，最终写入 {finalImportMarkers.length}
                  </p>
                </div>
                {showMappingControls && (
                  <button
                    type="button"
                    onClick={() => setMappingRows(jointPreview.mappingRows.map(row => ({ ...row })))}
                    className="shrink-0 px-2 py-1 rounded border border-gray-200 bg-white text-xs text-gray-600 hover:bg-gray-50"
                  >
                    恢复默认
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded border border-gray-200">
                <table className="w-full">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    {showMappingControls ? (
                      <tr>
                        <th className="px-3 py-2 font-medium">剧本构作</th>
                        <th className="px-2 py-2 font-medium text-center">→</th>
                        <th className="px-3 py-2 font-medium">导入构作</th>
                        <th className="px-3 py-2 font-medium">处理</th>
                        <th className="px-3 py-2 font-medium"></th>
                      </tr>
                    ) : (
                      <tr>
                        <th className="px-3 py-2 font-medium">剧本构作一览（根据导入剧本生成）</th>
                        <th className="px-3 py-2 font-medium"></th>
                      </tr>
                    )}
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {displayMappingRows.map(({ row, sourceIndex }, index) => {
                      const finalMarker = row.imported ?? row.extracted;
                      const isChapter = !!(hasMappedScenes && finalMarker && !finalMarker.parentNum);
                      if (!showMappingControls) {
                        return (
                          <tr key={row.id} className={isChapter ? "bg-gray-50" : ""}>
                            <td className="px-3 py-2 text-gray-700">{markerLabel(finalMarker)}</td>
                            <td className="px-3 py-2">
                              {hasMarkerDetails(finalMarker) && (
                                <span className="inline-flex rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 border border-emerald-100">
                                  {markerDetailsUpdateLabel(finalMarker)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      }
                      const importedDisplayMarker = preserveDisplayMarkers?.get(index) ?? null;
                      const isCreateGap = !row.extracted && !!row.imported;
                      const isPreserveGap = !!row.extracted && !row.imported;
                      const importedDisplaySuffix = isCreateGap ? "【新建】" : (isPreserveGap ? "【保留】" : "");
                      const importedDisplayClassName = isCreateGap ? "px-3 py-2 font-bold text-emerald-600" : isPreserveGap ? "px-3 py-2 font-bold text-purple-800/80" : importedDisplayMarker ? "px-3 py-2 text-gray-700" : "px-3 py-2 text-gray-400";
                      const importedDisplaySuffixClassName = isCreateGap ? "text-emerald-500/50" : "text-purple-400/75";
                      const canUndoCreate = isCreateGap && canUndoMappingGap(compactMappingRows, index, "extracted");
                      const canUndoPreserve = isPreserveGap && canUndoMappingGap(compactMappingRows, index, "imported");
                      return (
                        <tr key={row.id} className={isChapter ? "bg-gray-50" : ""}>
                          <td className={row.extracted ? "px-3 py-2 text-gray-700" : "px-3 py-2 text-gray-400"}>{markerLabel(row.extracted)}</td>
                          <td className="px-2 py-2 text-center text-gray-400">→</td>
                          <td className={importedDisplayClassName}>{markerLabelWithSuffix(importedDisplayMarker, importedDisplaySuffix, importedDisplaySuffixClassName)}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1.5">
                              {isCreateGap ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => undoMappingGap(sourceIndex, "extracted")}
                                    disabled={!canUndoCreate}
                                    className={`${MAPPING_BUTTON_CLASS} bg-white text-gray-600 border-gray-200`}
                                  >
                                    撤销新建
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => applyMappingAction(sourceIndex, "create")}
                                    disabled
                                    className={`${MAPPING_CURRENT_BUTTON_CLASS} bg-green-600 text-white border-green-600`}
                                  >
                                    新建
                                  </button>
                                </>
                              ) : isPreserveGap ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => undoMappingGap(sourceIndex, "imported")}
                                    disabled={!canUndoPreserve}
                                    className={`${MAPPING_BUTTON_CLASS} bg-white text-gray-600 border-gray-200`}
                                  >
                                    撤销保留
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => applyMappingAction(sourceIndex, "preserve")}
                                    disabled
                                    className={`${MAPPING_CURRENT_BUTTON_CLASS} bg-purple-600 text-white border-purple-600`}
                                  >
                                    保留
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className={`${MAPPING_BUTTON_CLASS} bg-blue-600 text-white border-blue-600`}
                                  >
                                    确认
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => applyMappingAction(sourceIndex, "create")}
                                    disabled={!row.extracted}
                                    className={`${MAPPING_BUTTON_CLASS} bg-white text-gray-600 border-gray-200`}
                                  >
                                    新建
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => applyMappingAction(sourceIndex, "preserve")}
                                    disabled={!row.imported}
                                    className={`${MAPPING_BUTTON_CLASS} bg-white text-gray-600 border-gray-200`}
                                  >
                                    保留
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {hasMarkerDetails(importedDisplayMarker) && (
                              <span className="inline-flex rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 border border-emerald-100">
                                {markerDetailsUpdateLabel(importedDisplayMarker)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {scriptPreview.charsToAdd.length > 0 && (
            <div className="rounded border border-gray-200 p-3 text-sm">
              <p className="font-medium text-green-700 mb-1">新增角色</p>
              <div className="flex flex-wrap gap-1">
                {scriptPreview.charsToAdd.map(c => (
                  <span key={c.name} className="bg-green-50 text-green-800 px-2 py-0.5 rounded text-xs">
                    {c.name}{c.isAggregate ? " (聚合)" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
          {scriptPreview.charConflicts.length > 0 && (
            <div className="rounded border border-red-200 p-3 text-sm">
              <p className="font-medium text-red-700 mb-1">角色冲突（将按现有设置保留）</p>
              {scriptPreview.charConflicts.map(c => (
                <p key={c.name} className="text-red-600">
                  {c.name}: 现有 {c.existingAggregate ? "聚合" : "普通"} vs 导入 {c.incomingAggregate ? "聚合" : "普通"}
                </p>
              ))}
            </div>
          )}
          {scriptPreview.warningRehearsalMarks.length > 0 && (
            <div className="rounded border border-amber-200 p-3 text-sm">
              <p className="font-medium text-amber-700 mb-1">格式异常的排练记号</p>
              <div className="flex flex-wrap gap-1">
                {scriptPreview.warningRehearsalMarks.map(m => (
                  <span key={m} className="bg-amber-50 text-amber-800 px-2 py-0.5 rounded text-xs font-mono">{m}</span>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={handleCommit} disabled={commitLoading} className="px-4 py-2 border border-red-600 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50">{commitLoading ? "导入中…" : "确认导入"}</button>
          </div>
        </div>
      )}

      {pendingCommitConfirmation && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setPendingCommitConfirmation(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[380px] rounded-2xl bg-white p-5 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-800">确认继续操作？</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-500">
              {skipDramaturgy
                ? "将从剧本中推断章节信息，并覆盖当前版本。\n所有在当前剧本和构作中未保存的更新将会丢失。\n确认继续？"
                : "将同时导入章节信息和剧本内容，并覆盖当前版本。\n所有在当前剧本和构作中未保存的更新将会丢失。\n确认继续？"}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPendingCommitConfirmation(false)}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
              >
                取消
              </button>
              <button
                onClick={(e) => {
                  (e.currentTarget as HTMLButtonElement).disabled = true;
                  setPendingCommitConfirmation(false);
                  void commitImport();
                }}
                className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {step === "done" && commitResult && (
        <div className="space-y-4">
          <div className="rounded bg-green-50 border border-green-200 p-4 text-green-800">成功导入：构作 {skipDramaturgy ? "已生成" : commitResult.importedScenes}，剧本 {commitResult.blocksImported}，角色 {commitResult.charsAdded}</div>
          {commitResult.sceneSummary.length > 0 && (
            <div className="rounded border border-gray-200 overflow-hidden text-sm">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs text-gray-500">
                    <th className="px-3 py-2 font-medium">段落</th>
                    <th className="px-3 py-2 font-medium">名称</th>
                    <th className="px-3 py-2 font-medium text-right">行数</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {commitResult.sceneSummary.map((scene, index) => (
                    <tr key={scene.sceneId ?? `__none_${index}`} className="text-gray-700">
                      <td className="px-3 py-1.5 font-mono text-xs">{scene.num ?? "—"}</td>
                      <td className="px-3 py-1.5">{scene.name ?? <span className="text-gray-400">未分配段落</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{scene.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button onClick={() => onDone?.()} className="px-4 py-2 bg-gray-800 text-white text-sm rounded">完成</button>
        </div>
      )}
    </div>
  );
}
