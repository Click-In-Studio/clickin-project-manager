"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { SheetMeta } from "@/lib/import/types";

type Props = {
  onSelect: (spreadsheetToken: string, sheet: SheetMeta) => void;
};

export default function SheetPicker({ onSelect }: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spreadsheetToken, setSpreadsheetToken] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetMeta[]>([]);

  async function handleLoad() {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setSheets([]);
    try {
      const res = await fetch(`${BASE_PATH}/api/feishu-sheet?url=${encodeURIComponent(url)}`);
      const data = await res.json() as { spreadsheetToken?: string; sheets?: SheetMeta[]; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? "加载失败"); return; }
      setSpreadsheetToken(data.spreadsheetToken!);
      setSheets(data.sheets!);
      if (data.sheets!.length === 1) onSelect(data.spreadsheetToken!, data.sheets![0]);
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
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
          />
          <button
            onClick={handleLoad}
            disabled={loading || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "加载中…" : "加载"}
          </button>
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
                onClick={() => onSelect(spreadsheetToken!, sheet)}
                className="w-full text-left px-3 py-2 rounded border border-gray-200 hover:bg-blue-50 hover:border-blue-300 text-sm"
              >
                <span className="font-medium">{sheet.title}</span>
                <span className="ml-2 text-gray-400 text-xs">{sheet.rowCount} 行 × {sheet.columnCount} 列</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
