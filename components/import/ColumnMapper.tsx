"use client";

import type { SheetData } from "@/lib/import/types";

type ColumnDef = {
  key: string;
  label: string;
  required?: boolean;
  multi?: boolean; // allows selecting multiple columns
};

type Props = {
  sheetData: SheetData;
  columns: ColumnDef[];
  mapping: Record<string, number | number[] | null>;
  onChange: (key: string, value: number | number[] | null) => void;
  /** If true, show a preview of row[0] under each selector */
  showPreview?: boolean;
};

export default function ColumnMapper({ sheetData, columns, mapping, onChange, showPreview }: Props) {
  const { headers, rows } = sheetData;
  const previewRow = rows[0] ?? [];

  const options = headers.map((h, i) => ({ label: h, idx: i }));

  return (
    <div className="space-y-3">
      {columns.map(col => {
        const current = mapping[col.key];
        if (col.multi) {
          const selected = (current as number[] | null) ?? [];
          return (
            <div key={col.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {col.label} {col.required && <span className="text-red-500">*</span>}
                <span className="ml-1 text-gray-400 font-normal text-xs">（可多选，拖拽排序）</span>
              </label>
              <div className="flex flex-wrap gap-1 mb-1">
                {selected.map(idx => (
                  <span key={idx} className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded">
                    {headers[idx]}
                    <button onClick={() => onChange(col.key, selected.filter(i => i !== idx))} className="hover:text-red-600">×</button>
                  </span>
                ))}
              </div>
              <select
                className="border border-gray-300 rounded px-2 py-1.5 text-sm"
                value=""
                onChange={e => {
                  const idx = parseInt(e.target.value);
                  if (!isNaN(idx) && !selected.includes(idx)) onChange(col.key, [...selected, idx]);
                }}
              >
                <option value="">+ 添加列</option>
                {options.filter(o => !selected.includes(o.idx)).map(o => (
                  <option key={o.idx} value={o.idx}>{o.label}</option>
                ))}
              </select>
              {showPreview && selected.length > 0 && (
                <p className="mt-0.5 text-xs text-gray-400 truncate">
                  预览: {selected.map(i => previewRow[i] ?? "—").join(" | ")}
                </p>
              )}
            </div>
          );
        }

        const selectedIdx = current as number | null;
        return (
          <div key={col.key}>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {col.label} {col.required && <span className="text-red-500">*</span>}
            </label>
            <select
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-full max-w-xs"
              value={selectedIdx ?? ""}
              onChange={e => {
                const val = e.target.value;
                onChange(col.key, val === "" ? null : parseInt(val));
              }}
            >
              <option value="">{col.required ? "请选择" : "【不导入】"}</option>
              {options.map(o => (
                <option key={o.idx} value={o.idx}>{o.label}</option>
              ))}
            </select>
            {showPreview && selectedIdx != null && (
              <p className="mt-0.5 text-xs text-gray-400 truncate">
                预览: {previewRow[selectedIdx] ?? "—"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
