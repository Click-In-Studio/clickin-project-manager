"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import SheetPicker from "./SheetPicker";
import ColumnMapper from "./ColumnMapper";
import type { SheetMeta, SheetData, SceneColMap, ImportScenePreview } from "@/lib/import/types";

type Step = "sheet" | "columns" | "preview" | "done";

type Props = {
  productionId: string;
  versionId?: string | null;
  onDone?: () => void;
};

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

export default function ImportScenesWizard({ productionId, versionId, onDone }: Props) {
  const [step, setStep] = useState<Step>("sheet");
  const [spreadsheetToken, setSpreadsheetToken] = useState<string | null>(null);
  const [selectedSheet, setSelectedSheet] = useState<SheetMeta | null>(null);
  const [sheetData, setSheetData] = useState<SheetData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [mapping, setMapping] = useState<Record<string, number | null>>({
    sceneNum: null, sceneName: null, intro: null,
    actionLine: null, music: null, stagePres: null, duration: null,
  });
  const [hasHeader, setHasHeader] = useState(true);

  const [preview, setPreview] = useState<ImportScenePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitResult, setCommitResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSheetData(token: string, sheet: SheetMeta) {
    setLoadingData(true);
    setDataError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/feishu-sheet/${encodeURIComponent(token)}/${encodeURIComponent(sheet.sheetId)}?rowCount=${sheet.rowCount}`);
      const data = await res.json() as { data?: SheetData; error?: string };
      if (!res.ok || data.error) { setDataError(data.error ?? "加载失败"); return; }
      setSheetData(data.data!);

      // Auto-detect column mapping by header names
      const headers = data.data!.headers;
      const autoMap: Record<string, number | null> = { sceneNum: null, sceneName: null, intro: null, actionLine: null, music: null, stagePres: null, duration: null };
      const hints: Record<string, string[]> = {
        sceneNum: ["段落编号", "段落号", "章节号", "编号", "序号"],
        sceneName: ["段落名", "章节名", "名称", "场次名"],
        intro: ["简介", "内容简介"],
        actionLine: ["行动线", "动作线"],
        music: ["音乐", "配乐"],
        stagePres: ["舞台呈现", "舞台提示", "舞台说明"],
        duration: ["预期时长", "时长", "预计时长"],
      };
      for (const [field, candidates] of Object.entries(hints)) {
        const idx = headers.findIndex(h => candidates.some(c => h.includes(c)));
        if (idx >= 0) autoMap[field] = idx;
      }
      setMapping(autoMap);
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

  function buildColMap(): SceneColMap | null {
    if (mapping.sceneNum == null) return null;
    return {
      sceneNum: mapping.sceneNum,
      sceneName: mapping.sceneName ?? undefined,
      intro: mapping.intro ?? undefined,
      actionLine: mapping.actionLine ?? undefined,
      music: mapping.music ?? undefined,
      stagePres: mapping.stagePres ?? undefined,
      duration: mapping.duration ?? undefined,
    };
  }

  async function handlePreview() {
    const colMap = buildColMap();
    if (!colMap || !sheetData) return;
    setPreviewLoading(true);
    setError(null);
    try {
      const versionQuery = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/import-scenes${versionQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetToken, sheetId: selectedSheet!.sheetId, rowCount: selectedSheet!.rowCount, colMap, headerRowIncluded: false }),
      });
      const data = await readApiResult<{ preview?: ImportScenePreview }>(res, "预览失败");
      if (!res.ok || data.error) { setError(data.error ?? "预览失败"); return; }
      setPreview(data.preview!);
      setStep("preview");
    } catch {
      setError("网络错误");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommit() {
    const colMap = buildColMap();
    if (!colMap || !sheetData) return;
    setCommitLoading(true);
    setError(null);
    try {
      const versionQuery = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/import-scenes${versionQuery}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetToken, sheetId: selectedSheet!.sheetId, rowCount: selectedSheet!.rowCount, colMap, headerRowIncluded: false }),
      });
      const data = await readApiResult<{ imported?: number }>(res, "导入失败");
      if (!res.ok || data.error) { setError(data.error ?? "导入失败"); return; }
      setCommitResult({ imported: data.imported! });
      setStep("done");
    } catch {
      setError("网络错误");
    } finally {
      setCommitLoading(false);
    }
  }

  const colDefs = [
    { key: "sceneNum", label: "段落编号", required: true },
    { key: "sceneName", label: "段落名（可选）" },
    { key: "intro", label: "简介（可选）" },
    { key: "actionLine", label: "行动线（可选）" },
    { key: "music", label: "音乐（可选）" },
    { key: "stagePres", label: "舞台呈现（可选）" },
    { key: "duration", label: "预期时长（可选）" },
  ];

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-bold">导入章节信息</h1>

      {/* Step indicators */}
      <div className="flex items-center gap-2 text-sm">
        {(["sheet", "columns", "preview", "done"] as Step[]).map((s, i) => {
          const labels: Record<Step, string> = { sheet: "选择表格", columns: "设置列", preview: "确认", done: "完成" };
          const active = s === step;
          const done = ["sheet", "columns", "preview", "done"].indexOf(step) > i;
          return (
            <span key={s} className={`flex items-center gap-1 ${active ? "text-blue-600 font-semibold" : done ? "text-green-600" : "text-gray-400"}`}>
              {i > 0 && <span className="text-gray-300">→</span>}
              {labels[s]}
            </span>
          );
        })}
      </div>

      {/* Step: sheet selection */}
      {step === "sheet" && (
        <div>
          <SheetPicker onSelect={handleSheetSelect} />
          {loadingData && <p className="text-sm text-gray-500 mt-2">加载表格数据中…</p>}
          {dataError && <p className="text-sm text-red-600 mt-2">{dataError}</p>}
        </div>
      )}

      {/* Step: column mapping */}
      {step === "columns" && sheetData && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">表格: {selectedSheet?.title}</span>
            <button onClick={() => setStep("sheet")} className="text-xs text-blue-600 hover:underline">重新选择</button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="hasHeader"
              checked={hasHeader}
              onChange={e => setHasHeader(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="hasHeader" className="text-sm text-gray-700">第一行是表头（已自动跳过）</label>
          </div>

          <ColumnMapper
            sheetData={sheetData}
            columns={colDefs}
            mapping={mapping as Record<string, number | number[] | null>}
            onChange={(key, val) => setMapping(m => ({ ...m, [key]: val as number | null }))}
            showPreview
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={handlePreview}
            disabled={previewLoading || mapping.sceneNum == null}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {previewLoading ? "生成预览…" : "下一步：预览"}
          </button>
        </div>
      )}

      {/* Step: preview */}
      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="rounded border border-gray-200 divide-y divide-gray-100 text-sm">
            {preview.scenesToAdd.length > 0 && (
              <div className="p-3">
                <p className="font-medium text-green-700 mb-1">新增段落 ({preview.scenesToAdd.length})</p>
                <ul className="space-y-0.5 text-gray-600">
                  {preview.scenesToAdd.map(s => (
                    <li key={s.num} className="flex gap-2">
                      <span className="font-mono text-green-600">+</span>
                      <span>{s.num} {s.name}</span>
                      {s.parentNum && <span className="text-gray-400">（上级: {s.parentNum}）</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.scenesToUpdate.length > 0 && (
              <div className="p-3">
                <p className="font-medium text-amber-700 mb-1">更新名称 ({preview.scenesToUpdate.length})</p>
                <ul className="space-y-0.5 text-gray-600">
                  {preview.scenesToUpdate.map(s => (
                    <li key={s.num}>
                      <span className="font-mono text-amber-600">~</span> {s.num}: {s.oldName} → <strong>{s.newName}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.conflicts.length > 0 && (
              <div className="p-3">
                <p className="font-medium text-red-700 mb-1">冲突 ({preview.conflicts.length})</p>
                <ul className="space-y-0.5 text-gray-600">
                  {preview.conflicts.map((c, i) => (
                    <li key={i} className="text-red-600">
                      {c.kind === "parentMissing" && `段落 ${c.sceneNum} 缺少上级段落 ${c.parentNum}`}
                      {c.kind === "nameMismatch" && `段落 ${c.sceneNum} 名称冲突：现有"${c.existing}"，导入"${c.incoming}"`}
                      {c.kind === "markerMissing" && `段落 ${c.sceneNum} 尚未在剧本中建立章节/场标记`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.metaToUpdate > 0 && (
              <div className="p-3">
                <p className="font-medium text-blue-700">更新详情 ({preview.metaToUpdate} 个已有段落将写入简介/行动线等字段)</p>
              </div>
            )}
            {preview.scenesToAdd.length === 0 && preview.scenesToUpdate.length === 0 && preview.metaToUpdate === 0 && (
              <div className="p-3 text-gray-500">没有需要导入的内容</div>
            )}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-3">
            <button onClick={() => setStep("columns")} className="px-4 py-2 border border-gray-300 text-sm rounded hover:bg-gray-50">返回</button>
            {preview.conflicts.length === 0 && (preview.scenesToAdd.length > 0 || preview.scenesToUpdate.length > 0 || preview.metaToUpdate > 0) && (
              <button
                onClick={handleCommit}
                disabled={commitLoading}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {commitLoading ? "导入中…" : "确认导入"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step: done */}
      {step === "done" && commitResult && (
        <div className="space-y-4">
          <div className="rounded bg-green-50 border border-green-200 p-4 text-green-800">
            成功导入 {commitResult.imported} 个段落
          </div>
          <button
            onClick={() => onDone?.()}
            className="px-4 py-2 bg-gray-800 text-white text-sm rounded hover:bg-gray-900"
          >
            完成
          </button>
        </div>
      )}
    </div>
  );
}
