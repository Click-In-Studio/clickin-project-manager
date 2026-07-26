"use client";

import { useRef, useEffect } from "react";
import { DEFAULT_COLUMNS, type TableViewConfigData, getDefaultViewConfig } from "./SceneTableView";

type Props = {
  config: TableViewConfigData;
  onChange: (config: TableViewConfigData) => void;
  onClose: () => void;
};

export default function TableColumnSettings({ config, onChange, onClose }: Props) {
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const toggleColumn = (key: string) => {
    const newVisible = config.visibleColumns.includes(key)
      ? config.visibleColumns.filter((k) => k !== key)
      : [...config.visibleColumns, key];
    onChange({ ...config, visibleColumns: newVisible });
  };

  const handleDragStart = (key: string) => {
    dragItem.current = key;
  };

  const handleDragEnter = (key: string) => {
    dragOverItem.current = key;
  };

  const handleDragEnd = () => {
    if (dragItem.current && dragOverItem.current && dragItem.current !== dragOverItem.current) {
      const newOrder = [...config.columnOrder];
      const dragIndex = newOrder.indexOf(dragItem.current);
      const dropIndex = newOrder.indexOf(dragOverItem.current);
      newOrder.splice(dragIndex, 1);
      newOrder.splice(dropIndex, 0, dragItem.current);
      onChange({ ...config, columnOrder: newOrder });
    }
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const columnsByOrder = config.columnOrder
    .map((key) => DEFAULT_COLUMNS.find((c) => c.key === key)!)
    .filter(Boolean);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-zinc-200 bg-white shadow-lg z-20"
    >
      <div className="px-3 py-2 border-b border-zinc-100">
        <p className="text-xs font-semibold text-zinc-600">列设置</p>
      </div>
      <div className="py-1 max-h-80 overflow-y-auto">
        {columnsByOrder.map((col) => (
          <div
            key={col.key}
            draggable
            onDragStart={() => handleDragStart(col.key)}
            onDragEnter={() => handleDragEnter(col.key)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 cursor-grab active:cursor-grabbing"
          >
            <span className="text-zinc-300 text-xs select-none">⋮⋮</span>
            <input
              type="checkbox"
              checked={config.visibleColumns.includes(col.key)}
              onChange={() => toggleColumn(col.key)}
              className="rounded border-zinc-300 text-zinc-800 focus:ring-zinc-400"
            />
            <span className="text-xs text-zinc-600 flex-1">{col.label}</span>
          </div>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-zinc-100 flex gap-2">
        <button
          onClick={() => onChange(getDefaultViewConfig())}
          className="flex-1 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded transition-colors"
        >
          重置
        </button>
        <button
          onClick={onClose}
          className="flex-1 px-2 py-1 text-xs text-white bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
