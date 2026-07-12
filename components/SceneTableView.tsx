"use client";

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { SceneDetail } from "@/lib/db";
import MountPointAssets from "@/components/assets/MountPointAssets";
import { parseDuration, formatDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/scene-duration";

export type TableColumnDef = {
  key: string;
  label: string;
  defaultWidth: number;
  editable?: boolean;
  multiline?: boolean;
};

export const DEFAULT_COLUMNS: TableColumnDef[] = [
  { key: "number",      label: "编号",     defaultWidth: 80  },
  { key: "name",        label: "名称",     defaultWidth: 160, editable: true },
  { key: "synopsis",    label: "简介",     defaultWidth: 240, editable: true, multiline: true },
  { key: "actionLine",  label: "行动线",   defaultWidth: 240, editable: true, multiline: true },
  { key: "music",       label: "音乐",     defaultWidth: 160, editable: true, multiline: true },
  { key: "stageNotes",  label: "舞台呈现", defaultWidth: 200, editable: true, multiline: true },
  { key: "duration",    label: "预期时长", defaultWidth: 100 },
  { key: "marks",       label: "排练记号", defaultWidth: 140 },
  { key: "assets",      label: "附件",     defaultWidth: 80  },
];

export type TableViewConfigData = {
  columnOrder: string[];
  visibleColumns: string[];
  columnWidths: Record<string, number>;
};

export function getDefaultViewConfig(): TableViewConfigData {
  const columnOrder = DEFAULT_COLUMNS.map(c => c.key);
  const visibleColumns = [...columnOrder];
  const columnWidths: Record<string, number> = {};
  for (const c of DEFAULT_COLUMNS) columnWidths[c.key] = c.defaultWidth;
  return { columnOrder, visibleColumns, columnWidths };
}

export type SceneTableViewProps = {
  productionId: string;
  scenes: SceneDetail[];
  rehearsalMarks: Record<string, string[]>;
  canEdit: boolean;
  versionId: string | null;
  viewConfig: TableViewConfigData;
  onViewConfigChange: (config: TableViewConfigData) => void;
  onUpdateScene: (sceneId: string, name: string) => Promise<void>;
  onPatchMeta: (sceneId: string, fields: Partial<Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">>) => Promise<void>;
  onDeleteScene?: (sceneId: string) => Promise<void>;
};

function MetaCell({
  value,
  canEdit,
  multiline,
  onSave,
}: {
  value: string;
  canEdit: boolean;
  multiline?: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(draft); setEditing(false); }
    catch { /* keep editing open so user can retry */ }
    finally { setSaving(false); }
  };

  if (editing) {
    if (multiline) {
      return (
        <textarea
          autoFocus
          ref={(el) => { textareaRef.current = el; }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(e) => {
            if (isComposing) return;
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); commit(); }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              const textarea = textareaRef.current;
              if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const next = draft.slice(0, start) + "\n" + draft.slice(end);
                setDraft(next);
                requestAnimationFrame(() => {
                  textarea.selectionStart = textarea.selectionEnd = start + 1;
                });
              }
            }
            if (e.key === "Escape") { setDraft(value); setEditing(false); }
          }}
          disabled={saving}
          rows={3}
          className="w-full rounded border border-zinc-300 px-2 py-1 text-xs leading-relaxed outline-none resize-none focus:border-zinc-500 disabled:opacity-50"
        />
      );
    }
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={(e) => {
          if (isComposing) return;
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        disabled={saving}
        className="w-full rounded border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500 disabled:opacity-50"
      />
    );
  }

  return (
    <div
      className={`text-xs text-zinc-600 whitespace-pre-wrap break-words min-h-[1.25rem] ${canEdit ? "cursor-text hover:bg-zinc-50 rounded px-1 -mx-1" : ""}`}
      onDoubleClick={() => canEdit && setEditing(true)}
      title={canEdit ? "双击编辑" : undefined}
    >
      {value || <span className="text-zinc-300 italic">—</span>}
    </div>
  );
}

function DurationCell({
  value,
  canEdit,
  onSave,
}: {
  value: string;
  canEdit: boolean;
  onSave: (seconds: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  const displayValue = useMemo(() => {
    const seconds = parseDuration(value);
    return seconds != null ? formatDuration(seconds) : "";
  }, [value]);

  useEffect(() => {
    if (editing) setDraft(displayValue);
  }, [editing, displayValue]);

  const commit = async () => {
    const trimmed = draft.trim();
    let seconds: number | null = null;
    if (trimmed) {
      seconds = parseDuration(trimmed);
      if (seconds == null) {
        setEditing(false);
        return;
      }
    }
    const origSeconds = parseDuration(value);
    if (seconds === origSeconds) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(seconds); setEditing(false); }
    catch { /* keep editing open so user can retry */ }
    finally { setSaving(false); }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={(e) => {
          if (isComposing) return;
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setEditing(false); }
        }}
        disabled={saving}
        className="w-full rounded border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500 disabled:opacity-50"
        placeholder="如 1:30"
      />
    );
  }

  return (
    <div
      className={`text-xs text-zinc-500 min-h-[1.25rem] ${canEdit ? "cursor-text hover:bg-zinc-50 rounded px-1 -mx-1" : ""}`}
      onDoubleClick={() => canEdit && setEditing(true)}
      title={canEdit ? "双击编辑" : undefined}
    >
      {displayValue || <span className="text-zinc-300 italic">—</span>}
    </div>
  );
}

function SceneNameCell({
  scene,
  canEdit,
  onUpdate,
}: {
  scene: SceneDetail;
  canEdit: boolean;
  onUpdate: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scene.name ?? "");
  const [saving, setSaving] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(scene.name ?? "");
  }, [scene.name, editing]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (trimmed === (scene.name ?? "")) { setEditing(false); return; }
    setSaving(true);
    try { await onUpdate(trimmed); setEditing(false); }
    catch { /* keep editing open so user can retry */ }
    finally { setSaving(false); }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={(e) => {
          if (isComposing) return;
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(scene.name ?? ""); setEditing(false); }
        }}
        disabled={saving}
        className="w-full border-b border-zinc-400 text-xs text-zinc-800 outline-none disabled:opacity-50 bg-transparent"
      />
    );
  }

  return (
    <span
      className={`text-xs ${canEdit ? "cursor-text hover:opacity-70" : ""}`}
      onDoubleClick={() => canEdit && setEditing(true)}
      title={canEdit ? "双击编辑" : undefined}
    >
      {scene.name || <span className="italic text-zinc-300">未命名</span>}
    </span>
  );
}

export default function SceneTableView({
  productionId,
  scenes,
  rehearsalMarks,
  canEdit,
  versionId,
  viewConfig,
  onViewConfigChange,
  onUpdateScene,
  onPatchMeta,
  onDeleteScene,
}: SceneTableViewProps) {
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set());
  const [collapsedChapters, setCollapsedChapters] = useState<Set<string>>(new Set());
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    return () => { resizeCleanupRef.current?.(); };
  }, []);

  const visibleColumns = useMemo(() => {
    return viewConfig.columnOrder
      .filter(key => viewConfig.visibleColumns.includes(key))
      .map(key => DEFAULT_COLUMNS.find(c => c.key === key)!)
      .filter(Boolean);
  }, [viewConfig]);

  const acts = useMemo(() => scenes.filter(s => s.parentId === null), [scenes]);
  const subScenes = useCallback((actId: string) => scenes.filter(s => s.parentId === actId), [scenes]);

  const toggleAssets = (sceneId: string) => {
    setExpandedAssets(prev => {
      const next = new Set(prev);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return next;
    });
  };

  const toggleChapter = (actId: string) => {
    setCollapsedChapters(prev => {
      const next = new Set(prev);
      if (next.has(actId)) next.delete(actId);
      else next.add(actId);
      return next;
    });
  };

  const handleResizeStart = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = viewConfig.columnWidths[key] ?? DEFAULT_COLUMNS.find(c => c.key === key)?.defaultWidth ?? 100;
    resizingRef.current = { key, startX: e.clientX, startWidth };

    const handleMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const diff = ev.clientX - resizingRef.current.startX;
      const newWidth = Math.max(40, resizingRef.current.startWidth + diff);
      onViewConfigChange({
        ...viewConfig,
        columnWidths: { ...viewConfig.columnWidths, [resizingRef.current.key]: newWidth },
      });
    };

    const cleanup = () => {
      resizingRef.current = null;
      resizeCleanupRef.current = null;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    const handleUp = () => cleanup();

    resizeCleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  const renderCell = (scene: SceneDetail, colKey: string, isChapter: boolean, children?: SceneDetail[]) => {
    const marks = rehearsalMarks[scene.id] ?? [];
    const uniqueMarks = [...new Set(marks)];

    switch (colKey) {
      case "number":
        return (
          <div className={`flex items-center gap-1 ${isChapter ? "" : "pl-6"}`}>
            {isChapter && (
              <button
                onClick={() => toggleChapter(scene.id)}
                className="text-zinc-400 hover:text-zinc-600 w-4 text-xs flex-shrink-0"
                title={collapsedChapters.has(scene.id) ? "展开" : "收起"}
              >
                {collapsedChapters.has(scene.id) ? "▶" : "▼"}
              </button>
            )}
            <span className={`text-sm tabular-nums ${isChapter ? "font-semibold text-zinc-600" : "text-zinc-400"}`}>
              {scene.number || "—"}
            </span>
          </div>
        );

      case "name":
        return (
          <div className={isChapter ? "font-medium text-zinc-700" : "text-zinc-600"}>
            <SceneNameCell
              scene={scene}
              canEdit={canEdit}
              onUpdate={(name) => onUpdateScene(scene.id, name)}
            />
          </div>
        );

      case "synopsis":
        return (
          <MetaCell
            value={scene.synopsis ?? ""}
            canEdit={canEdit}
            multiline
            onSave={(v) => onPatchMeta(scene.id, { synopsis: v })}
          />
        );

      case "actionLine":
        return (
          <MetaCell
            value={scene.actionLine ?? ""}
            canEdit={canEdit}
            multiline
            onSave={(v) => onPatchMeta(scene.id, { actionLine: v })}
          />
        );

      case "music":
        return (
          <MetaCell
            value={scene.music ?? ""}
            canEdit={canEdit}
            multiline
            onSave={(v) => onPatchMeta(scene.id, { music: v })}
          />
        );

      case "stageNotes":
        return (
          <MetaCell
            value={scene.stageNotes ?? ""}
            canEdit={canEdit}
            multiline
            onSave={(v) => onPatchMeta(scene.id, { stageNotes: v })}
          />
        );

      case "duration":
        if (isChapter && children && children.length > 0) {
          const chapterDuration = getChapterDurationDisplay(children);
          return (
            <div className="text-xs text-zinc-500">
              {chapterDuration
                ? (chapterDuration.hasMissingDuration && !canEdit
                  ? <span className="italic text-zinc-300">—</span>
                  : chapterDuration.text || <span className="italic text-zinc-300">—</span>)
                : <span className="italic text-zinc-300">—</span>}
            </div>
          );
        }
        return (
          <DurationCell
            value={scene.expectedDuration ?? ""}
            canEdit={canEdit}
            onSave={async (seconds) => {
              await onPatchMeta(scene.id, {
                expectedDuration: seconds != null ? seconds.toString() : ""
              });
            }}
          />
        );

      case "marks":
        return (
          <div className="flex flex-wrap gap-1">
            {uniqueMarks.map((m) => (
              <span key={m} className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-zinc-400 bg-zinc-100">
                {m}
              </span>
            ))}
            {uniqueMarks.length === 0 && <span className="text-zinc-300 text-xs">—</span>}
          </div>
        );

      case "assets":
        return (
          <button
            onClick={() => toggleAssets(scene.id)}
            className="text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded px-2 py-0.5 transition-colors"
          >
            📎 附件
          </button>
        );

      default:
        return null;
    }
  };

  const renderRow = (scene: SceneDetail, isChapter: boolean, children?: SceneDetail[]) => {
    const isExpanded = expandedAssets.has(scene.id);
    return (
      <React.Fragment key={scene.id}>
        <tr className={`group border-b border-zinc-100 ${isChapter ? "bg-zinc-50/60" : ""}`}>
          {visibleColumns.map((col) => (
            <td
              key={col.key}
              className="px-3 py-2.5 align-top"
              style={{ width: viewConfig.columnWidths[col.key] ?? col.defaultWidth }}
            >
              {renderCell(scene, col.key, isChapter, children)}
            </td>
          ))}
        </tr>
        {isExpanded && (
          <tr className="border-b border-zinc-100 bg-zinc-50/30">
            <td colSpan={visibleColumns.length} className="px-4 py-3">
              <MountPointAssets
                productionId={productionId}
                mountType="scene"
                mountId={scene.id}
                label={`${scene.number}${scene.name ? ` ${scene.name}` : ""}`}
                canEdit={canEdit}
                versionId={versionId ?? undefined}
                display="compact"
              />
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  const totalWidth = visibleColumns.reduce(
    (sum, col) => sum + (viewConfig.columnWidths[col.key] ?? col.defaultWidth), 0
  );

  return (
    <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
      <table
        ref={tableRef}
        className="border-collapse text-left"
        style={{ minWidth: totalWidth }}
      >
        <thead className="sticky top-0 z-10 bg-white">
          <tr className="border-b border-zinc-200">
            {visibleColumns.map((col) => (
              <th
                key={col.key}
                className="relative px-3 py-3 text-xs font-medium text-zinc-400 select-none"
                style={{ width: viewConfig.columnWidths[col.key] ?? col.defaultWidth }}
              >
                <span className="truncate block">{col.label}</span>
                <div
                  className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-zinc-300 transition-colors"
                  onMouseDown={(e) => handleResizeStart(e, col.key)}
                  title="拖动调整列宽"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {acts.map((act) => {
            const children = subScenes(act.id);
            const isCollapsed = collapsedChapters.has(act.id);
            return (
              <React.Fragment key={act.id}>
                {renderRow(act, true, children)}
                {!isCollapsed && children.map((child) => renderRow(child, false))}
              </React.Fragment>
            );
          })}
          {acts.length === 0 && (
            <tr>
              <td colSpan={visibleColumns.length} className="px-4 py-8 text-center text-sm text-zinc-300">
                暂无章节
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
