"use client";

import { useEffect, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { SheetMeta } from "@/lib/import/types";
import type { ReactNode } from "react";

type Props = {
  onSelect: (spreadsheetToken: string, sheet: SheetMeta) => void | Promise<void>;
  onLoaded?: (spreadsheetToken: string, sheets: SheetMeta[], url: string) => void;
  disabled?: boolean;
  initialUrl?: string;
  initialSpreadsheetToken?: string | null;
  initialSheets?: SheetMeta[];
  beforeLoadButton?: ReactNode;
};

const EMPTY_SHEETS: SheetMeta[] = [];

export default function SheetPicker({ onSelect, onLoaded, disabled = false, initialUrl = "", initialSpreadsheetToken = null, initialSheets = EMPTY_SHEETS, beforeLoadButton }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spreadsheetToken, setSpreadsheetToken] = useState<string | null>(initialSpreadsheetToken);
  const [sheets, setSheets] = useState<SheetMeta[]>(initialSheets);
  const [selectingSheetId, setSelectingSheetId] = useState<string | null>(null);
  const selectingSheet = selectingSheetId !== null;
  const effectiveDisabled = disabled || loading || selectingSheet;

  useEffect(() => {
    setUrl(initialUrl);
    setSpreadsheetToken(initialSpreadsheetToken);
    setSheets(initialSheets);
    setError(null);
    setSelectingSheetId(null);
  }, [initialUrl, initialSpreadsheetToken, initialSheets]);

  async function handleLoad() {
    const trimmedUrl = url.trim();
    if (effectiveDisabled || !trimmedUrl) return;
    setLoading(true);
    setError(null);
    setSheets([]);
    try {
      const res = await fetch(`${BASE_PATH}/api/feishu-sheet?url=${encodeURIComponent(trimmedUrl)}`);
      const data = await res.json() as { spreadsheetToken?: string; sheets?: SheetMeta[]; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? "加载失败"); return; }
      setSpreadsheetToken(data.spreadsheetToken!);
      setSheets(data.sheets!);
      onLoaded?.(data.spreadsheetToken!, data.sheets!, trimmedUrl);
      if (data.sheets!.length === 1) onSelect(data.spreadsheetToken!, data.sheets![0]);
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }

  async function handleSheetSelect(sheet: SheetMeta) {
    if (effectiveDisabled || !spreadsheetToken) return;
    setSelectingSheetId(sheet.sheetId);
    try {
      await onSelect(spreadsheetToken, sheet);
    } finally {
      setSelectingSheetId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">飞书表格链接</label>
        <div className="flex gap-2">
          <input
            type="url"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="https://xxx.feishu.cn/sheets/... 或 wiki 链接"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLoad()}
            disabled={effectiveDisabled}
          />
          <button
            onClick={handleLoad}
            disabled={effectiveDisabled || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "加载中…" : "加载"}
          </button>
          {beforeLoadButton}
        </div>
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      </div>

      {sheets.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">选择工作表</label>
          <div className="space-y-1">
            {sheets.map(sheet => (
              <button
                key={sheet.sheetId}
                onClick={() => handleSheetSelect(sheet)}
                disabled={effectiveDisabled}
                className={`w-full text-left px-3 py-2 rounded border text-sm disabled:opacity-50 ${
                  selectingSheetId === sheet.sheetId
                    ? "border-blue-300 bg-blue-50 disabled:bg-blue-50 disabled:border-blue-300"
                    : "border-gray-200 hover:bg-blue-50 hover:border-blue-300 disabled:hover:bg-white disabled:hover:border-gray-200"
                }`}
              >
                <span className="font-medium">{sheet.title}</span>
                <span className="ml-2 text-gray-400 text-xs">{sheet.rowCount} 行 × {sheet.columnCount} 列</span>
              </button>
            ))}
          </div>
          {selectingSheet && <p className="mt-2 text-sm text-gray-500">多维表格加载中...</p>}
        </div>
      )}
    </div>
  );
}
