"use client";

import { useRef, useEffect, type CSSProperties, type RefObject } from "react";
import { DEFAULT_COLUMNS, type TableViewConfigData, getDefaultViewConfig } from "./SceneTableView";

type Props = {
  config: TableViewConfigData;
  onChange: (config: TableViewConfigData) => void;
  onClose: () => void;
  nestedFromOverflow?: boolean;
  nestedMenuRef?: RefObject<HTMLDivElement | null>;
  nestedMenuStyle?: CSSProperties;
};

export default function TableColumnSettings({
  config,
  onChange,
  onClose,
  nestedFromOverflow = false,
  nestedMenuRef,
  nestedMenuStyle,
}: Props) {
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (nestedFromOverflow) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, nestedFromOverflow]);

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
      ref={nestedFromOverflow ? nestedMenuRef : ref}
      data-production-overflow-menu-child={nestedFromOverflow ? "true" : undefined}
      style={{
        ...(nestedFromOverflow
          ? nestedMenuStyle
          : { position: "absolute", right: 0, top: "calc(100% + 10px)" }),
        width: 220, borderRadius: 12,
        border: "1px solid var(--line)", background: "var(--surface)",
        boxShadow: "0 4px 20px rgba(24,42,42,.10)", zIndex: nestedFromOverflow ? 40 : 20,
      }}
    >
      <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--line)" }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".06em", textTransform: "uppercase" }}>
          列设置
        </p>
      </div>
      <div style={{ padding: "4px 0", maxHeight: 320, overflowY: "auto" }}>
        {columnsByOrder.map((col) => {
          const checked = config.visibleColumns.includes(col.key);
          return (
            <div
              key={col.key}
              draggable
              onDragStart={() => handleDragStart(col.key)}
              onDragEnter={() => handleDragEnter(col.key)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => toggleColumn(col.key)}
              style={{
                display: "flex", alignItems: "center", gap: 9,
                padding: "6px 14px", cursor: "grab",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "")}
            >
              <span style={{ fontSize: 10, color: "var(--line)", userSelect: "none", letterSpacing: 1 }}>⋮⋮</span>
              {/* Custom checkbox */}
              <span style={{
                width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                border: checked ? "none" : "1.5px solid var(--line)",
                background: checked ? "var(--ink)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background .1s",
              }}>
                {checked && (
                  <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                    <path d="M1 3l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </span>
              <span style={{ fontSize: 12, color: "var(--ink)", flex: 1 }}>{col.label}</span>
            </div>
          );
        })}
      </div>
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
        <button
          onClick={() => onChange(getDefaultViewConfig())}
          style={{
            flex: 1, padding: "5px 8px", fontSize: 11, fontWeight: 700,
            border: "1px solid var(--line)", borderRadius: 7, cursor: "pointer",
            background: "transparent", color: "var(--muted)",
          }}
        >
          重置
        </button>
        <button
          onClick={onClose}
          style={{
            flex: 1, padding: "5px 8px", fontSize: 11, fontWeight: 700,
            border: 0, borderRadius: 7, cursor: "pointer",
            background: "var(--ink)", color: "#fff",
          }}
        >
          关闭
        </button>
      </div>
    </div>
  );
}
