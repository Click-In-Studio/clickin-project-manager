"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import SheetPicker from "./SheetPicker";
import ColumnMapper from "./ColumnMapper";
import type { SheetMeta, SheetData, SceneColMap, ScriptColMap, ImportScenePreview, ImportScriptPreview, TypeTagMapping, AggregateMembers, StageDelimiterPattern, ScriptConfigStageDelimiterPattern } from "@/lib/import/types";

type Step = "choose-dramaturgy" | "choose-script" | "scene-columns" | "script-columns" | "types" | "characters" | "aggregates" | "preview" | "done";
type Props = { productionId: string; versionId?: string | null; onDone?: () => void; };
type CharEntry = { raw: string; parsedBase: string; parsedSuffix: string | null; mergeAsNote: boolean; kind: "normal" | "aggregate" };
type TagGroupInfo = { id: string; name: string; options: { id: string; label: string; color: string }[] };
type Workbook = { token: string; sheets: SheetMeta[] };
type SheetPickerPreset = { url: string; token: string; sheets: SheetMeta[]; nonce: number };
type ApiResult<T> = Partial<T> & { error?: string; status?: string; migration?: { phase?: string } };

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
const STAGE_DELIMITER_PATTERNS: StageDelimiterPattern[] = ["（）", "【】", "()", "[]"];
const SCRIPT_CONFIG_STAGE_DELIMITER_PATTERNS: ScriptConfigStageDelimiterPattern[] = ["（）", "【】"];
const BLOCK_TYPE_LABELS: Record<string, string> = { dialogue: "台词", stage: "舞台提示", lyric: "歌词", marker: "章节分界线" };

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
  const [stageInlinePatterns, setStageInlinePatterns] = useState<StageDelimiterPattern[]>([]);
  const [stageDelimiterPattern, setStageDelimiterPattern] = useState<ScriptConfigStageDelimiterPattern>("（）");
  const [typeValues, setTypeValues] = useState<string[]>([]);
  const [typeTagMapping, setTypeTagMapping] = useState<TypeTagMapping>({});
  const [tagGroups, setTagGroups] = useState<TagGroupInfo[]>([]);
  const [tagGroupsLoading, setTagGroupsLoading] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newOptionLabel, setNewOptionLabel] = useState<Record<string, string>>({});
  const [charEntries, setCharEntries] = useState<CharEntry[]>([]);
  const [aggregateMembers, setAggregateMembers] = useState<AggregateMembers>({});
  const [scenePreview, setScenePreview] = useState<ImportScenePreview | null>(null);
  const [scriptPreview, setScriptPreview] = useState<ImportScriptPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitResult, setCommitResult] = useState<{ importedScenes: number; blocksImported: number; charsAdded: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function goBack() {
    if (step === "choose-script") setStep("choose-dramaturgy");
    else if (step === "scene-columns") setStep("choose-script");
    else if (step === "script-columns") setStep(skipDramaturgy ? "choose-script" : "scene-columns");
    else if (step === "types") setStep("script-columns");
    else if (step === "characters") setStep(typeValues.length > 0 ? "types" : "script-columns");
    else if (step === "aggregates") setStep("characters");
    else if (step === "preview") setStep(aggEntries.length > 0 ? "aggregates" : charEntries.length > 0 ? "characters" : typeValues.length > 0 ? "types" : "script-columns");
  }

  function autoSceneMapping(headers: string[]): Record<string, number | null> {
    const hints: Record<string, string[]> = {
      sceneNum: ["段落编号", "段落号", "章节号", "编号", "序号"],
      sceneName: ["段落名", "章节名", "名称", "场次名"],
      intro: ["简介", "内容简介", "内容"],
      actionLine: ["行动线", "动作线"],
      music: ["音乐", "配乐"],
      stagePres: ["舞台呈现", "舞台提示", "舞台说明"],
      duration: ["预期时长", "时长", "预计时长", "time"],
    };
    const next: Record<string, number | null> = { sceneNum: null, sceneName: null, intro: null, actionLine: null, music: null, stagePres: null, duration: null };
    for (const [field, candidates] of Object.entries(hints)) {
      const idx = headers.findIndex(h => candidates.some(c => h.includes(c)));
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
      const idx = headers.findIndex(h => candidates.some(c => h.includes(c)));
      if (idx >= 0) next[field] = idx;
    }
    const bodyIdx = headers.findIndex(h => ["剧本", "内容", "台词", "文本"].some(c => h.includes(c)));
    if (bodyIdx >= 0) next.bodyColumns = [bodyIdx];
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
        setScenePreview(null);
        setStep("choose-script");
      } else {
        setScriptWorkbook(prev => ({ token, sheets: prev?.token === token ? prev.sheets : [sheet] }));
        setScriptSheet(sheet);
        setScriptData(payload);
        setScriptMapping(autoScriptMapping(payload.headers));
        setTypeValues([]);
        setTypeTagMapping({});
        setTagGroups([]);
        setCharEntries([]);
        setAggregateMembers({});
        setScriptPreview(null);
        setCommitResult(null);
        setStep(dramData && !skipDramaturgy ? "scene-columns" : "script-columns");
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

  async function runPreview() {
    const sceneColMap = buildSceneColMap();
    const scriptColMap = buildScriptColMap();
    if (!scriptColMap || !scriptSheet || !scriptWorkbook) return;
    if (!skipDramaturgy && (!sceneColMap || !dramSheet || !dramWorkbook)) return;
    setPreviewLoading(true);
    setError(null);
    const characterKinds: Record<string, "normal" | "aggregate"> = {};
    for (const e of charEntries) characterKinds[effectiveName(e)] = e.kind;
    try {
      const versionQuery = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
      const sceneRequest = skipDramaturgy ? null : fetch(`${BASE_PATH}/api/production/${productionId}/import-scenes${versionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spreadsheetToken: dramWorkbook!.token,
            sheetId: dramSheet!.sheetId,
            rowCount: dramSheet!.rowCount,
            colMap: sceneColMap,
            headerRowIncluded: hasSceneHeader,
          }),
        });
      const [sceneRes, scriptRes] = await Promise.all([
        sceneRequest,
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
          }),
        }),
      ]);
      const sceneData = sceneRes ? await readApiResult<{ preview?: ImportScenePreview }>(sceneRes, "章节预览失败") : null;
      const scriptData = await readApiResult<{ preview?: ImportScriptPreview }>(scriptRes, "剧本预览失败");
      if (sceneRes && (!sceneRes.ok || sceneData?.error)) { setError(sceneData?.error ?? "章节预览失败"); return; }
      if (!scriptRes.ok || scriptData.error) { setError(scriptData.error ?? "剧本预览失败"); return; }
      setScenePreview(sceneData?.preview ?? null);
      setScriptPreview(scriptData.preview!);
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
    if (!skipDramaturgy && scenePreview?.conflicts.length) {
      setError("章节信息存在冲突，请先处理后再导入");
      return;
    }
    if (!window.confirm(skipDramaturgy ? "将从剧本段落推断构作，并覆盖当前版本的构作与剧本。确认继续？" : "将同时导入章节信息和剧本内容，并覆盖当前版本的构作与剧本。确认继续？")) return;
    setCommitLoading(true);
    setError(null);
    const characterKinds: Record<string, "normal" | "aggregate"> = {};
    for (const e of charEntries) characterKinds[effectiveName(e)] = e.kind;
    try {
      let importedScenes = 0;
      if (!skipDramaturgy) {
        const versionQuery = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
        const sceneRes = await fetch(`${BASE_PATH}/api/production/${productionId}/import-scenes${versionQuery}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spreadsheetToken: dramWorkbook!.token,
            sheetId: dramSheet!.sheetId,
            rowCount: dramSheet!.rowCount,
            colMap: sceneColMap,
            headerRowIncluded: hasSceneHeader,
            replaceExisting: true,
          }),
        });
        const sceneData = await readApiResult<{ imported?: number }>(sceneRes, "章节导入失败");
        if (!sceneRes.ok || sceneData.error) { setError(sceneData.error ?? "章节导入失败"); return; }
        importedScenes = sceneData.imported!;
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
          replaceScenesFromScript: skipDramaturgy,
          useVersionSceneRows: !skipDramaturgy,
        }),
      });
      const scriptData = await readApiResult<{ blocksImported?: number; charsAdded?: number }>(scriptRes, "剧本导入失败");
      if (!scriptRes.ok || scriptData.error) { setError(scriptData.error ?? "剧本导入失败"); return; }
      setCommitResult({ importedScenes, blocksImported: scriptData.blocksImported!, charsAdded: scriptData.charsAdded! });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setCommitLoading(false);
    }
  }

  function gotoScriptTypes() {
    const typeCol = scriptMapping.typeTag as number | null;
    if (typeCol == null || !scriptData) {
      gotoCharacters();
      return;
    }
    const vals = new Set<string>([""]);
    for (const row of scriptData.rows) {
      const v = row[typeCol]?.trim();
      if (!v) continue;
      for (const part of v.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean)) vals.add(part);
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
      .then(r => r.json())
      .then((data: { groups?: TagGroupInfo[] }) => { if (data.groups) setTagGroups(data.groups); })
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
      const data = await res.json() as { group?: TagGroupInfo };
      if (data.group) {
        setTagGroups(groups => [...groups, { ...data.group!, options: [] }]);
        setNewGroupName("");
      }
    } catch { /* non-fatal */ }
  }

  async function addTagOption(groupId: string) {
    const label = (newOptionLabel[groupId] ?? "").trim();
    if (!label) return;
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups/${groupId}/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, color: "#a1a1aa", sortOrder: 0 }),
      });
      const data = await res.json() as { option?: TagGroupInfo["options"][number] };
      if (data.option) {
        setTagGroups(groups => groups.map(group => (
          group.id === groupId ? { ...group, options: [...group.options, data.option!] } : group
        )));
        setNewOptionLabel(labels => ({ ...labels, [groupId]: "" }));
      }
    } catch { /* non-fatal */ }
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

  const stepLabels: Record<Step, string> = {
    "choose-dramaturgy": "构作来源",
    "choose-script": "剧本来源",
    "scene-columns": "构作配置",
    "script-columns": "剧本配置",
    types: "类型映射",
    characters: "角色类型",
    aggregates: "聚合角色",
    preview: "确认",
    done: "完成",
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-bold">导入</h1>
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">本次导入将会覆盖既有的构作和剧本内容。</p>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {(["choose-dramaturgy", "choose-script", "scene-columns", "script-columns", "types", "characters", "aggregates", "preview", "done"] as Step[]).map((s, i, arr) => (
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
                  setScenePreview(null);
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
          <div className="space-y-4">
            <SheetPicker
              key={scriptPickerPreset?.nonce ?? "script-picker"}
              initialUrl={scriptPickerPreset?.url ?? ""}
              initialSpreadsheetToken={scriptPickerPreset?.token ?? null}
              initialSheets={scriptPickerPreset?.sheets}
              onLoaded={(token, sheets) => {
                setScriptWorkbook({ token, sheets });
                setScriptPickerPreset(null);
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
                  {loadingScriptOption === "reuse" ? "加载中..." : "沿用上次输入"}
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
              onClick={() => setStep("script-columns")}
              disabled={sceneMapping.sceneNum == null}
              className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              下一步：剧本列
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
                  <span className="text-xs text-gray-400">不定项选择</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-gray-500">统一替换为</p>
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
                  <span className="text-xs text-gray-400">单项选择</span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={gotoScriptTypes} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">下一步：类型映射</button>
          </div>
        </div>
      )}

      {step === "types" && (
        <div className="space-y-4">
          <div className="rounded border border-gray-200 p-3 space-y-3">
            <p className="text-sm font-medium text-gray-700">Tag 组{tagGroupsLoading ? "（加载中...）" : ""}</p>
            {tagGroups.map(group => (
              <div key={group.id} className="space-y-1.5">
                <p className="text-xs font-medium text-gray-600">{group.name}</p>
                <div className="flex flex-wrap gap-1.5 items-center">
                  {group.options.map(option => (
                    <span key={option.id} className="px-2 py-0.5 rounded text-xs text-white" style={{ background: option.color }}>{option.label}</span>
                  ))}
                  <div className="flex gap-1">
                    <input
                      type="text"
                      placeholder="新选项"
                      value={newOptionLabel[group.id] ?? ""}
                      onChange={e => setNewOptionLabel(labels => ({ ...labels, [group.id]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") addTagOption(group.id); }}
                      className="border border-gray-200 rounded px-1.5 py-0.5 text-xs w-20 focus:outline-none focus:border-blue-400"
                    />
                    <button onClick={() => addTagOption(group.id)} className="px-1.5 py-0.5 text-xs bg-gray-100 rounded hover:bg-gray-200">+</button>
                  </div>
                </div>
              </div>
            ))}
            <div className="flex gap-1.5 items-center pt-1">
              <input
                type="text"
                placeholder="新建 Tag 组名称"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createTagGroup(); }}
                className="border border-gray-200 rounded px-2 py-1 text-xs w-40 focus:outline-none focus:border-blue-400"
              />
              <button onClick={createTagGroup} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">创建</button>
            </div>
          </div>

          <p className="text-sm font-medium text-gray-700">类型映射</p>
          {typeValues.map(val => {
            const action = typeTagMapping[val] ?? { action: "mapType", blockType: "dialogue" };
            const tagAction = action.action === "mapTag" ? action as { action: "mapTag"; groupId: string; optionId: string } : null;
            return (
              <div key={val} className="flex items-center gap-2 flex-wrap">
                <span className="w-28 text-sm font-medium truncate">{val || <span className="text-gray-400 italic">空白</span>}</span>
                <select className="border border-gray-300 rounded px-2 py-1 text-sm" value={action.action} onChange={e => {
                  const a = e.target.value as TypeTagMapping[string]["action"];
                  const firstGroup = tagGroups[0]; const firstOption = firstGroup?.options[0];
                  setTypeTagMapping(m => ({
                    ...m,
                    [val]: a === "ignore" ? { action: "ignore" }
                      : a === "mapTag" ? { action: "mapTag", groupId: firstGroup?.id ?? "", optionId: firstOption?.id ?? "" }
                      : { action: "mapType", blockType: "dialogue" },
                  }));
                }}>
                  <option value="mapType">映射到类型</option><option value="mapTag" disabled={tagGroups.length === 0}>映射到 Tag</option><option value="ignore">忽略该行</option>
                </select>
                {action.action === "mapType" && <select className="border border-gray-300 rounded px-2 py-1 text-sm" value={(action as { action: "mapType"; blockType: string }).blockType} onChange={e => setTypeTagMapping(m => ({ ...m, [val]: { action: "mapType", blockType: e.target.value as "dialogue" | "stage" | "lyric" | "marker" } }))}>{Object.entries(BLOCK_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
                {tagAction && <>
                  <select className="border border-gray-300 rounded px-2 py-1 text-sm" value={tagAction.groupId} onChange={e => { const gid = e.target.value; const firstOpt = tagGroups.find(g => g.id === gid)?.options[0]; setTypeTagMapping(m => ({ ...m, [val]: { action: "mapTag", groupId: gid, optionId: firstOpt?.id ?? "" } })); }}>{tagGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                  <select className="border border-gray-300 rounded px-2 py-1 text-sm" value={tagAction.optionId} onChange={e => setTypeTagMapping(m => ({ ...m, [val]: { ...tagAction, optionId: e.target.value } }))}>{(tagGroups.find(g => g.id === tagAction.groupId)?.options ?? []).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
                </>}
              </div>
            );
          })}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={gotoCharacters} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">下一步：角色类型</button>
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
            <button onClick={gotoAggregates} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">{aggEntries.length > 0 ? "下一步：聚合角色" : "下一步：预览"}</button>
          </div>
        </div>
      )}

      {step === "aggregates" && (
        <div className="space-y-4">
          {aggEntries.map(agg => {
            const aggName = effectiveName(agg);
            return <div key={aggName} className="rounded border border-gray-200 p-3 space-y-2"><p className="font-medium text-sm">{aggName}</p><div className="flex flex-wrap gap-2">{normalEntries.map(m => { const mName = effectiveName(m); const selected = (aggregateMembers[aggName] ?? []).includes(mName); return <button key={mName} onClick={() => setAggregateMembers(prev => { const cur = prev[aggName] ?? []; return { ...prev, [aggName]: selected ? cur.filter(n => n !== mName) : [...cur, mName] }; })} className={`px-2 py-0.5 rounded text-sm border ${selected ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-600"}`}>{mName}</button>; })}</div></div>;
          })}
          <div className="flex gap-3">
            <button onClick={goBack} className="px-4 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded hover:bg-gray-50">上一步</button>
            <button onClick={runPreview} disabled={previewLoading} className="px-4 py-2 border border-blue-600 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">{previewLoading ? "生成预览…" : "下一步：预览"}</button>
          </div>
        </div>
      )}

      {step === "preview" && scriptPreview && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3 text-center text-sm">
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-purple-600">{skipDramaturgy ? "自动" : (scenePreview ? scenePreview.scenesToAdd.length + scenePreview.scenesToUpdate.length : 0)}</div>
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
          {skipDramaturgy ? (
            <div className="rounded border border-gray-200 p-3 text-sm">
              <p className="font-medium text-gray-700 mb-1">构作更新</p>
              <p className="text-gray-600">将根据剧本的段落列生成构作，并覆盖当前版本的构作。</p>
            </div>
          ) : scenePreview && (
            <div className="rounded border border-gray-200 p-3 text-sm">
              <p className="font-medium text-gray-700 mb-1">构作更新</p>
              <p className="text-gray-600">新增 {scenePreview.scenesToAdd.length}，更新 {scenePreview.scenesToUpdate.length}，写入详情 {scenePreview.metaToUpdate}</p>
              {scenePreview.conflicts.length > 0 && (
                <p className="mt-1 text-red-600">存在 {scenePreview.conflicts.length} 个冲突，需处理后才能导入。</p>
              )}
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
            <button onClick={handleCommit} disabled={commitLoading || (!skipDramaturgy && !!scenePreview?.conflicts.length)} className="px-4 py-2 border border-red-600 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50">{commitLoading ? "导入中…" : "确认导入"}</button>
          </div>
        </div>
      )}

      {step === "done" && commitResult && (
        <div className="space-y-4">
          <div className="rounded bg-green-50 border border-green-200 p-4 text-green-800">成功导入：构作 {skipDramaturgy ? "已生成" : commitResult.importedScenes}，剧本 {commitResult.blocksImported}，角色 {commitResult.charsAdded}</div>
          <button onClick={() => onDone?.()} className="px-4 py-2 bg-gray-800 text-white text-sm rounded">完成</button>
        </div>
      )}
    </div>
  );
}
