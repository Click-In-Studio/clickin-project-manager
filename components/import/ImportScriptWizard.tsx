"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import SheetPicker from "./SheetPicker";
import ColumnMapper from "./ColumnMapper";
import type { SheetMeta, SheetData, ScriptColMap, TypeTagMapping, TypeAction, ImportScriptPreview, AggregateMembers } from "@/lib/import/types";

type Step = "sheet" | "columns" | "types" | "characters" | "aggregates" | "preview" | "done";

type Props = {
  productionId: string;
  versionId?: string | null;
  onDone?: () => void;
};

const BLOCK_TYPE_LABELS: Record<string, string> = {
  dialogue: "台词", stage: "舞台提示", lyric: "歌词",
};

/** Client-side character parsing — mirrors lib/import/parse-character.ts */
function parseCharName(raw: string): { name: string; note: string | null } {
  const s = raw.trim();
  const parenMatch = s.match(/^(.+?)[（(](.+?)[）)]\s*$/);
  if (parenMatch) return { name: parenMatch[1].trim(), note: parenMatch[2].trim() };
  const suffixMatch = s.match(/^(.+?)([A-Z]{1,4})$/);
  if (suffixMatch && suffixMatch[1].trim() && /[^\x00-\x7F]/.test(suffixMatch[1])) return { name: suffixMatch[1].trim(), note: suffixMatch[2] };
  return { name: s, note: null };
}

function guessAgg(name: string) { return /们|全体|合唱|合|众|群/.test(name); }

type CharEntry = {
  raw: string;
  parsedBase: string;         // base name from suffix detection (= raw when no suffix)
  parsedSuffix: string | null; // detected annotation suffix (e.g. "VO" from "女VO"), null if none
  mergeAsNote: boolean;       // user choice: true = this raw maps to parsedBase (merged); false = raw is its own character
  kind: "normal" | "aggregate";
};

function effectiveName(e: CharEntry): string {
  return e.parsedSuffix !== null && e.mergeAsNote ? e.parsedBase : e.raw;
}

export default function ImportScriptWizard({ productionId, versionId, onDone }: Props) {
  const [step, setStep] = useState<Step>("sheet");
  const [spreadsheetToken, setSpreadsheetToken] = useState<string | null>(null);
  const [selectedSheet, setSelectedSheet] = useState<SheetMeta | null>(null);
  const [sheetData, setSheetData] = useState<SheetData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [colMapping, setColMapping] = useState<Record<string, number | number[] | null>>({
    sceneNum: null, rehearsalMark: null, typeTag: null,
    character: null, bodyColumns: [], stageInlineColumns: [],
  });
  const [stageInlinePatterns, setStageInlinePatterns] = useState<string[]>([]);

  const [typeValues, setTypeValues] = useState<string[]>([]);
  const [typeTagMapping, setTypeTagMapping] = useState<TypeTagMapping>({});

  // Tag groups (loaded from production when entering types step)
  type TagOptionInfo = { id: string; label: string; color: string };
  type TagGroupInfo = { id: string; name: string; options: TagOptionInfo[] };
  const [tagGroups, setTagGroups] = useState<TagGroupInfo[]>([]);
  const [tagGroupsLoading, setTagGroupsLoading] = useState(false);
  // Inline create state
  const [newGroupName, setNewGroupName] = useState("");
  const [newOptionLabel, setNewOptionLabel] = useState<Record<string, string>>({});

  // Characters: keyed by raw name
  const [charEntries, setCharEntries] = useState<CharEntry[]>([]);
  // Aggregate members: aggregateName → set of member names
  const [aggregateMembers, setAggregateMembers] = useState<AggregateMembers>({});

  const [preview, setPreview] = useState<ImportScriptPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  type SceneSummaryItem = { sceneId: string | null; num: string | null; name: string | null; count: number };
  const [commitResult, setCommitResult] = useState<{ blocksImported: number; charsAdded: number; sceneSummary: SceneSummaryItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSheetData(token: string, sheet: SheetMeta) {
    setLoadingData(true);
    setDataError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/feishu-sheet/${encodeURIComponent(token)}/${encodeURIComponent(sheet.sheetId)}?rowCount=${sheet.rowCount}`);
      const data = await res.json() as { data?: SheetData; error?: string };
      if (!res.ok || data.error) { setDataError(data.error ?? "加载失败"); return; }
      setSheetData(data.data!);

      const headers = data.data!.headers;
      const autoMap: Record<string, number | number[] | null> = {
        sceneNum: null, rehearsalMark: null, typeTag: null,
        character: null, bodyColumns: [], stageInlineColumns: [],
      };
      const hints: Record<string, string[]> = {
        sceneNum: ["段落", "场次", "编号", "段落号"],
        rehearsalMark: ["排练记号", "记号", "提示"],
        typeTag: ["类型", "tag", "标签"],
        character: ["角色", "演员"],
      };
      for (const [field, candidates] of Object.entries(hints)) {
        const idx = headers.findIndex(h => candidates.some(c => h.includes(c)));
        if (idx >= 0 && field !== "bodyColumns" && field !== "stageInlineColumns") autoMap[field] = idx;
      }
      const bodyIdx = headers.findIndex(h => ["剧本", "内容", "台词", "文本"].some(c => h.includes(c)));
      if (bodyIdx >= 0) autoMap.bodyColumns = [bodyIdx];

      setColMapping(autoMap);
      setStep("columns");
    } catch {
      setDataError("网络错误");
    } finally {
      setLoadingData(false);
    }
  }

  function handleSheetSelect(token: string, sheet: SheetMeta) {
    setSpreadsheetToken(token);
    setSelectedSheet(sheet);
    loadSheetData(token, sheet);
  }

  async function goToTypesStep() {
    setError(null);
    const typeCol = colMapping.typeTag as number | null;
    if (typeCol != null && sheetData) {
      // Collect all distinct type values, including the empty-cell key ("") and
      // multi-value splits (same delimiters as character column).
      const vals = new Set<string>([""]); // "" = blank cell
      for (const row of sheetData.rows) {
        const v = row[typeCol]?.trim();
        if (!v) continue;
        for (const part of v.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean)) {
          vals.add(part);
        }
      }
      const newVals = [...vals];
      setTypeValues(newVals);
      setTypeTagMapping(prev => {
        const next = { ...prev };
        for (const v of newVals) if (!next[v]) next[v] = { action: "mapType", blockType: "dialogue" };
        return next;
      });
      // Load existing tag groups
      setTagGroupsLoading(true);
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups`);
        const data = await res.json() as { groups?: TagGroupInfo[] };
        if (data.groups) setTagGroups(data.groups);
      } catch { /* non-fatal */ }
      setTagGroupsLoading(false);
      setStep("types");
    } else {
      goToCharactersStep();
    }
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
        setTagGroups(gs => [...gs, { ...data.group!, options: [] }]);
        setNewGroupName("");
      }
    } catch { /* ignore */ }
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
      const data = await res.json() as { option?: TagOptionInfo };
      if (data.option) {
        setTagGroups(gs => gs.map(g => g.id === groupId ? { ...g, options: [...g.options, data.option!] } : g));
        setNewOptionLabel(m => ({ ...m, [groupId]: "" }));
      }
    } catch { /* ignore */ }
  }

  function goToCharactersStep() {
    setError(null);
    const charCol = colMapping.character as number | null;
    if (charCol != null && sheetData) {
      // Collect every distinct raw string. Suffix detection result is stored but the
      // user decides in the UI whether to merge or treat as a new character.
      const seen = new Map<string, CharEntry>(); // key: raw
      for (const row of sheetData.rows) {
        const v = row[charCol];
        if (!v?.trim()) continue;
        for (const part of v.split(/[,，\n]+/)) {
          const raw = part.trim();
          if (!raw || seen.has(raw)) continue;
          const { name: parsedBase, note: parsedSuffix } = parseCharName(raw);
          const kind: "normal" | "aggregate" = guessAgg(parsedBase) ? "aggregate" : "normal";
          seen.set(raw, { raw, parsedBase, parsedSuffix, mergeAsNote: parsedSuffix !== null, kind });
        }
      }
      const entries = [...seen.values()];
      setCharEntries(entries);
      setStep("characters");
    } else {
      runPreview();
    }
  }

  function goToAggregatesStep() {
    setError(null);
    const hasAgg = charEntries.some(e => e.kind === "aggregate");
    if (hasAgg) {
      setAggregateMembers(prev => {
        const next = { ...prev };
        for (const e of charEntries) {
          const name = effectiveName(e);
          if (e.kind === "aggregate" && !next[name]) next[name] = [];
        }
        return next;
      });
      setStep("aggregates");
    } else {
      runPreview();
    }
  }

  async function runPreview() {
    if (!sheetData) return;
    setPreviewLoading(true);
    setError(null);
    const colMap = buildColMap();
    if (!colMap) { setError("请先完成列设置"); setPreviewLoading(false); return; }

    const characterKinds: Record<string, "normal" | "aggregate"> = {};
    for (const e of charEntries) characterKinds[effectiveName(e)] = e.kind;

    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/import-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetToken, sheetId: selectedSheet!.sheetId, rowCount: selectedSheet!.rowCount, colMap, typeTagMapping, characterKinds, headerRowIncluded: false }),
      });
      const data = await res.json() as { preview?: ImportScriptPreview; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? "预览失败"); setPreviewLoading(false); return; }
      setPreview(data.preview!);
      setStep("preview");
    } catch {
      setError("网络错误");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommit() {
    if (!sheetData) return;
    setCommitLoading(true);
    setError(null);
    const colMap = buildColMap();
    if (!colMap) { setError("列设置不完整"); setCommitLoading(false); return; }

    const characterKinds: Record<string, "normal" | "aggregate"> = {};
    for (const e of charEntries) characterKinds[effectiveName(e)] = e.kind;

    try {
      const importUrl = versionId
        ? `${BASE_PATH}/api/production/${productionId}/import-script?v=${encodeURIComponent(versionId)}`
        : `${BASE_PATH}/api/production/${productionId}/import-script`;
      const res = await fetch(importUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetToken, sheetId: selectedSheet!.sheetId, rowCount: selectedSheet!.rowCount,
          colMap, typeTagMapping, characterKinds, aggregateMembers, headerRowIncluded: false,
        }),
      });
      const data = await res.json() as { blocksImported?: number; charsAdded?: number; sceneSummary?: SceneSummaryItem[]; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? "导入失败"); setCommitLoading(false); return; }
      setCommitResult({ blocksImported: data.blocksImported!, charsAdded: data.charsAdded!, sceneSummary: data.sceneSummary ?? [] });
      setStep("done");
    } catch {
      setError("网络错误");
    } finally {
      setCommitLoading(false);
    }
  }

  function buildColMap(): ScriptColMap | null {
    const sceneNum = colMapping.sceneNum as number | null;
    if (sceneNum == null) return null;
    const bodyColumns = (colMapping.bodyColumns as number[] | null) ?? [];
    if (bodyColumns.length === 0) return null;
    return {
      sceneNum,
      rehearsalMark: (colMapping.rehearsalMark as number | null) ?? undefined,
      typeTag: (colMapping.typeTag as number | null) ?? undefined,
      character: (colMapping.character as number | null) ?? undefined,
      bodyColumns,
      stageInlineColumns: (colMapping.stageInlineColumns as number[] | null) ?? undefined,
      stageInlinePatterns: stageInlinePatterns.length > 0 ? stageInlinePatterns : undefined,
    };
  }

  const stepList: Step[] = ["sheet", "columns", "types", "characters", "aggregates", "preview", "done"];
  const stepLabels: Record<Step, string> = {
    sheet: "选择表格", columns: "设置列", types: "类型映射",
    characters: "角色类型", aggregates: "聚合角色", preview: "确认", done: "完成",
  };
  const currentStepIdx = stepList.indexOf(step);

  const colDefs = [
    { key: "sceneNum", label: "段落", required: true },
    { key: "bodyColumns", label: "剧本内容", required: true, multi: true },
    { key: "character", label: "角色" },
    { key: "rehearsalMark", label: "排练记号" },
    { key: "typeTag", label: "类型/Tag" },
    { key: "stageInlineColumns", label: "内嵌舞台提示列", multi: true },
  ];

  // Deduplicate by effective name for aggregates UI and API payload.
  const uniqueByName = new Map<string, CharEntry>();
  for (const e of charEntries) uniqueByName.set(effectiveName(e), e);
  const aggEntries = [...uniqueByName.values()].filter(e => e.kind === "aggregate");
  const normalEntries = [...uniqueByName.values()].filter(e => e.kind !== "aggregate");

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-bold">导入剧本内容</h1>
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        注意：导入剧本内容将<strong>清除</strong>当前所有剧本行，重新导入。角色和段落信息将合并不删除。
      </p>

      {/* Step indicators */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {stepList.map((s, i) => (
          <span key={s} className={`flex items-center gap-1 ${s === step ? "text-blue-600 font-semibold" : currentStepIdx > i ? "text-green-600" : "text-gray-400"}`}>
            {i > 0 && <span className="text-gray-300 mx-0.5">→</span>}
            {stepLabels[s]}
          </span>
        ))}
      </div>

      {/* Step: sheet */}
      {step === "sheet" && (
        <div>
          <SheetPicker onSelect={handleSheetSelect} />
          {loadingData && <p className="text-sm text-gray-500 mt-2">加载表格数据中…</p>}
          {dataError && <p className="text-sm text-red-600 mt-2">{dataError}</p>}
        </div>
      )}

      {/* Step: columns */}
      {step === "columns" && sheetData && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">表格: {selectedSheet?.title}</span>
            <button onClick={() => setStep("sheet")} className="text-xs text-blue-600 hover:underline">重新选择</button>
          </div>
          <ColumnMapper sheetData={sheetData} columns={colDefs} mapping={colMapping}
            onChange={(key, val) => setColMapping(m => ({ ...m, [key]: val }))} showPreview />

          {/* Inline stage direction patterns */}
          <div className="rounded border border-gray-200 p-3 space-y-2">
            <p className="text-sm font-medium text-gray-700">段内舞台提示识别</p>
            <p className="text-xs text-gray-500">选中后，正文中符合括号格式的文字将自动拆分为单独的舞台提示行</p>
            <div className="flex flex-wrap gap-4">
              {(["（）", "【】", "()", "[]"] as const).map(pat => (
                <label key={pat} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stageInlinePatterns.includes(pat)}
                    onChange={e => setStageInlinePatterns(ps =>
                      e.target.checked ? [...ps, pat] : ps.filter(p => p !== pat)
                    )}
                    className="rounded"
                  />
                  <code className="text-xs bg-gray-100 px-1 rounded">{pat}</code>
                </label>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={goToTypesStep}
            disabled={(colMapping.sceneNum as number | null) == null || ((colMapping.bodyColumns as number[])?.length ?? 0) === 0}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            下一步
          </button>
        </div>
      )}

      {/* Step: type mapping */}
      {step === "types" && (
        <div className="space-y-5">
          {/* Tag group setup */}
          <div className="rounded border border-gray-200 p-3 space-y-3">
            <p className="text-sm font-medium text-gray-700">Tag 组{tagGroupsLoading ? "（加载中…）" : ""}</p>
            {tagGroups.map(g => (
              <div key={g.id} className="space-y-1.5">
                <p className="text-xs font-medium text-gray-600">{g.name}</p>
                <div className="flex flex-wrap gap-1.5 items-center">
                  {g.options.map(o => (
                    <span key={o.id} className="px-2 py-0.5 rounded text-xs text-white" style={{ background: o.color }}>{o.label}</span>
                  ))}
                  <div className="flex gap-1">
                    <input
                      type="text"
                      placeholder="新选项"
                      value={newOptionLabel[g.id] ?? ""}
                      onChange={e => setNewOptionLabel(m => ({ ...m, [g.id]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") addTagOption(g.id); }}
                      className="border border-gray-200 rounded px-1.5 py-0.5 text-xs w-20 focus:outline-none focus:border-blue-400"
                    />
                    <button onClick={() => addTagOption(g.id)} className="px-1.5 py-0.5 text-xs bg-gray-100 rounded hover:bg-gray-200">+</button>
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

          {/* Type value mapping */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700">类型映射</p>
            {typeValues.map(val => {
              const action = typeTagMapping[val] ?? { action: "mapType", blockType: "dialogue" };
              const tagAction = action.action === "mapTag" ? action as { action: "mapTag"; groupId: string; optionId: string } : null;
              return (
                <div key={val} className="flex items-center gap-2 flex-wrap">
                  <span className="w-28 text-sm font-medium truncate" title={val || "（空白）"}>
                    {val || <span className="text-gray-400 italic">空白</span>}
                  </span>
                  <select className="border border-gray-300 rounded px-2 py-1 text-sm"
                    value={action.action}
                    onChange={e => {
                      const a = e.target.value as TypeAction["action"];
                      const firstGroup = tagGroups[0];
                      const firstOption = firstGroup?.options[0];
                      setTypeTagMapping(m => ({
                        ...m,
                        [val]: a === "ignore" ? { action: "ignore" }
                          : a === "mapTag" ? { action: "mapTag", groupId: firstGroup?.id ?? "", optionId: firstOption?.id ?? "" }
                          : { action: "mapType", blockType: "dialogue" },
                      }));
                    }}>
                    <option value="mapType">映射到类型</option>
                    <option value="mapTag" disabled={tagGroups.length === 0}>映射到 Tag{tagGroups.length === 0 ? "（先创建 Tag 组）" : ""}</option>
                    <option value="ignore">忽略该行</option>
                  </select>
                  {action.action === "mapType" && (
                    <select className="border border-gray-300 rounded px-2 py-1 text-sm"
                      value={(action as { action: "mapType"; blockType: string }).blockType}
                      onChange={e => setTypeTagMapping(m => ({ ...m, [val]: { action: "mapType", blockType: e.target.value as "dialogue" | "stage" | "lyric" } }))}>
                      {Object.entries(BLOCK_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  )}
                  {tagAction && (
                    <>
                      <select className="border border-gray-300 rounded px-2 py-1 text-sm"
                        value={tagAction.groupId}
                        onChange={e => {
                          const gid = e.target.value;
                          const firstOpt = tagGroups.find(g => g.id === gid)?.options[0];
                          setTypeTagMapping(m => ({ ...m, [val]: { action: "mapTag", groupId: gid, optionId: firstOpt?.id ?? "" } }));
                        }}>
                        {tagGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                      <select className="border border-gray-300 rounded px-2 py-1 text-sm"
                        value={tagAction.optionId}
                        onChange={e => setTypeTagMapping(m => ({ ...m, [val]: { ...tagAction, optionId: e.target.value } }))}>
                        {(tagGroups.find(g => g.id === tagAction.groupId)?.options ?? []).map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep("columns")} className="px-4 py-2 border border-gray-300 text-sm rounded hover:bg-gray-50">返回</button>
            <button onClick={goToCharactersStep} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">下一步</button>
          </div>
        </div>
      )}

      {/* Step: character kinds */}
      {step === "characters" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            检测到后缀标注的角色（如"女VO"），请选择是作为新角色还是合并为已有角色的备注。
          </p>
          <div className="rounded border border-gray-200 overflow-hidden text-sm">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">原始值</th>
                  <th className="px-3 py-2 font-medium">处理方式</th>
                  <th className="px-3 py-2 font-medium">角色名</th>
                  <th className="px-3 py-2 font-medium">聚合角色</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {charEntries.map((entry, idx) => (
                  <tr key={entry.raw} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-400 text-xs font-mono">{entry.raw}</td>
                    <td className="px-3 py-1.5">
                      {entry.parsedSuffix !== null ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => setCharEntries(es => es.map((x, i) => i === idx ? { ...x, mergeAsNote: false } : x))}
                            className={`px-2 py-0.5 rounded text-xs border transition-colors ${!entry.mergeAsNote ? "bg-gray-800 text-white border-gray-800" : "border-gray-200 text-gray-500 hover:border-gray-400"}`}
                          >
                            新角色
                          </button>
                          <button
                            onClick={() => setCharEntries(es => es.map((x, i) => i === idx ? { ...x, mergeAsNote: true } : x))}
                            className={`px-2 py-0.5 rounded text-xs border transition-colors ${entry.mergeAsNote ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-500 hover:border-blue-300"}`}
                          >
                            备注→{entry.parsedBase}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-sm">{effectiveName(entry)}</td>
                    <td className="px-3 py-1.5">
                      <input type="checkbox" checked={entry.kind === "aggregate"}
                        onChange={e => setCharEntries(es => es.map((x, i) => i === idx ? { ...x, kind: e.target.checked ? "aggregate" : "normal" } : x))}
                        className="rounded" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            <button onClick={() => typeValues.length > 0 ? setStep("types") : setStep("columns")} className="px-4 py-2 border border-gray-300 text-sm rounded hover:bg-gray-50">返回</button>
            <button onClick={goToAggregatesStep} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">下一步</button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {/* Step: aggregate members */}
      {step === "aggregates" && (
        <div className="space-y-5">
          <p className="text-sm text-gray-600">为每个聚合角色选择包含的成员角色。</p>
          {aggEntries.map(agg => {
            const aggName = effectiveName(agg);
            return (
              <div key={aggName} className="rounded border border-gray-200 p-3 space-y-2">
                <p className="font-medium text-sm">{aggName}</p>
                <div className="flex flex-wrap gap-2">
                  {normalEntries.map(m => {
                    const mName = effectiveName(m);
                    const selected = (aggregateMembers[aggName] ?? []).includes(mName);
                    return (
                      <button
                        key={mName}
                        onClick={() => setAggregateMembers(prev => {
                          const cur = prev[aggName] ?? [];
                          const next = selected ? cur.filter(n => n !== mName) : [...cur, mName];
                          return { ...prev, [aggName]: next };
                        })}
                        className={`px-2 py-0.5 rounded text-sm border transition-colors ${selected ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-600 hover:border-blue-300"}`}
                      >
                        {mName}
                      </button>
                    );
                  })}
                </div>
                {(aggregateMembers[aggName] ?? []).length === 0 && (
                  <p className="text-xs text-gray-400">未选择成员（可稍后在角色管理中配置）</p>
                )}
              </div>
            );
          })}
          <div className="flex gap-3">
            <button onClick={() => setStep("characters")} className="px-4 py-2 border border-gray-300 text-sm rounded hover:bg-gray-50">返回</button>
            <button onClick={runPreview} disabled={previewLoading} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">
              {previewLoading ? "生成预览…" : "下一步：预览"}
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {/* Step: preview */}
      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-blue-600">{preview.blockCount}</div>
              <div className="text-gray-500">剧本行</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-green-600">{preview.charsToAdd.length}</div>
              <div className="text-gray-500">新增角色</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-2xl font-bold text-amber-600">{preview.charConflicts.length}</div>
              <div className="text-gray-500">角色冲突</div>
            </div>
          </div>
          {preview.charsToAdd.length > 0 && (
            <div className="rounded border border-gray-200 p-3 text-sm">
              <p className="font-medium text-green-700 mb-1">新增角色</p>
              <div className="flex flex-wrap gap-1">
                {preview.charsToAdd.map(c => (
                  <span key={c.name} className="bg-green-50 text-green-800 px-2 py-0.5 rounded text-xs">
                    {c.name}{c.isAggregate ? " (聚合)" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
          {preview.charConflicts.length > 0 && (
            <div className="rounded border border-red-200 p-3 text-sm">
              <p className="font-medium text-red-700 mb-1">角色冲突（将按现有设置保留）</p>
              {preview.charConflicts.map(c => (
                <p key={c.name} className="text-red-600">
                  {c.name}: 现有 {c.existingAggregate ? "聚合" : "普通"} vs 导入 {c.incomingAggregate ? "聚合" : "普通"}
                </p>
              ))}
            </div>
          )}
          {preview.warningRehearsalMarks.length > 0 && (
            <div className="rounded border border-amber-200 p-3 text-sm">
              <p className="font-medium text-amber-700 mb-1">格式异常的排练记号</p>
              <div className="flex flex-wrap gap-1">
                {preview.warningRehearsalMarks.map(m => (
                  <span key={m} className="bg-amber-50 text-amber-800 px-2 py-0.5 rounded text-xs font-mono">{m}</span>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3">
            <button onClick={() => aggEntries.length > 0 ? setStep("aggregates") : charEntries.length > 0 ? setStep("characters") : typeValues.length > 0 ? setStep("types") : setStep("columns")}
              className="px-4 py-2 border border-gray-300 text-sm rounded hover:bg-gray-50">返回</button>
            <button onClick={handleCommit} disabled={commitLoading}
              className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50">
              {commitLoading ? "导入中…" : "确认导入（将清除现有剧本）"}
            </button>
          </div>
        </div>
      )}

      {/* Step: done */}
      {step === "done" && commitResult && (
        <div className="space-y-4">
          <div className="rounded bg-green-50 border border-green-200 p-4 text-green-800 space-y-1">
            <p className="font-medium">导入完成</p>
            <p className="text-sm">共 {commitResult.blocksImported} 行剧本，新增角色 {commitResult.charsAdded} 个</p>
          </div>
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
                  {commitResult.sceneSummary.map((s, i) => (
                    <tr key={s.sceneId ?? `__none_${i}`} className="text-gray-700">
                      <td className="px-3 py-1.5 font-mono text-xs">{s.num ?? "—"}</td>
                      <td className="px-3 py-1.5">{s.name ?? <span className="text-gray-400">未分配段落</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button onClick={() => onDone?.()} className="px-4 py-2 bg-gray-800 text-white text-sm rounded hover:bg-gray-900">完成</button>
        </div>
      )}
    </div>
  );
}
