"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { useVisibleEventSource } from "@/hooks/useVisibleEventSource";
import MountPointAssets from "../assets/MountPointAssets";
import RelatedWikiChips from "../wiki/RelatedWikiChips";
import type { SceneDetail } from "@/lib/script/script-scene-character-db";
import DurationInput from "@/components/ui/DurationInput";
import { parseDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/ops/scene-duration";
import { canDeleteScene, canMountScene, type SceneFieldPerms } from "@/lib/script/scene-field-perms-shared";
import BoundaryActionMenu from "@/components/script/BoundaryActionMenu";
import MarkerDeleteDialog, { type MarkerDeleteDialogState } from "@/components/script/MarkerDeleteDialog";
import type { MarkerDeleteOperation, MarkerProjection } from "@/lib/script/script-marker-domain";
import ChevronIcon from "@/components/ui/ChevronIcon";

type MetaFields = Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">;

type Props = {
  productionId: string;
  productionName: string;
  initialScenes: MarkerProjection[];
  openingChapterMarkerId: string | null;
  canEdit: boolean;
  /** 逐字段编辑权限；canEdit 是「值得显示编辑态」的粗门 */
  fieldPerms: SceneFieldPerms;
  embedded?: boolean;
  versionId?: string | null;
  initialExpandedId?: string;
  trackWrite?: <T>(operation: Promise<T>) => Promise<T>;
};

function isUpdatingResponse(payload: unknown): payload is { status: "updating" } {
  return typeof payload === "object" && payload !== null && "status" in payload && payload.status === "updating";
}

function MetaField({
  label,
  value: externalValue,
  multiline,
  canEdit,
  onSave,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  canEdit: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(externalValue);
  const [lastSeen, setLastSeen] = useState(externalValue);
  const [saving, setSaving] = useState(false);

  if (lastSeen !== externalValue) { setLastSeen(externalValue); setDraft(externalValue); }

  const commit = async () => {
    if (draft === externalValue) return;
    setSaving(true);
    try { await onSave(draft); } catch { /* 保留草稿，由顶栏提示重试。 */ } finally { setSaving(false); }
  };

  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">{label}</label>
      {canEdit ? (
        multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={2}
            className="h-10 w-full resize-y rounded border border-zinc-200 px-2 py-1.5 text-xs leading-relaxed outline-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300 sm:h-auto"
            placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving}
            className="w-full rounded border border-zinc-200 px-2 py-1.5 text-xs outline-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300"
            placeholder="—"
          />
        )
      ) : (
        <p className="text-xs text-zinc-600 whitespace-pre-wrap min-h-[1.25rem]">
          {externalValue || <span className="text-zinc-300 italic">—</span>}
        </p>
      )}
    </div>
  );
}

function SceneEditRow({
  scene,
  indent,
  marks,
  childScenes,
  canEdit,
  fieldPerms,
  canDelete,
  productionId,
  initialExpanded,
  onUpdate,
  onConvert,
  onDelete,
  onPatchMeta,
  canReorder,
  reorderBusy,
  canMoveUp,
  canMoveDown,
  onMove,
  isDragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  scene: MarkerProjection;
  indent: boolean;
  marks: string[];
  childScenes?: MarkerProjection[];
  canEdit: boolean;
  fieldPerms: SceneFieldPerms;
  canDelete: boolean;
  productionId: string;
  initialExpanded?: boolean;
  onUpdate: (name: string) => Promise<void>;
  onConvert: () => Promise<void>;
  onDelete: () => Promise<void>;
  onPatchMeta: (fields: Partial<MetaFields>) => Promise<void>;
  canReorder: boolean;
  reorderBusy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: "up" | "down") => Promise<void>;
  isDragging: boolean;
  dropEdge: "top" | "bottom" | null;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLTableRowElement>) => void;
  onDrop: (event: React.DragEvent<HTMLTableRowElement>) => void;
}) {
  const [sortingOpen, setSortingOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const [mobileAction, setMobileAction] = useState<"convert" | "delete" | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const chapterDurationDisplay = expanded && childScenes
    ? getChapterDurationDisplay(childScenes)
    : null;

  useEffect(() => {
    if (!canEdit) {
      setEditingName(false);
      setMobileAction(null);
    }
  }, [canEdit]);

  useEffect(() => {
    if (initialExpanded && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (draftName !== scene.name && !editingName) setDraftName(scene.name);

  const commit = async (name: string) => {
    if (name === scene.name) return;
    setSaving(true);
    try { await onUpdate(name); setEditingName(false); }
    catch { setEditingName(true); }
    finally { setSaving(false); }
  };

  const del = async () => {
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  const toggleExpanded = () => setExpanded((v) => !v);

  const handleRowClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button,input,textarea,select,a,[contenteditable='true'],[data-scene-editable='true']")) {
      return;
    }
    toggleExpanded();
  };

  return (
    <>
      <tr
        ref={rowRef}
        data-scene-sort-row
        onClick={handleRowClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={{
          boxShadow: dropEdge === "top"
            ? "inset 0 2px #2563eb"
            : dropEdge === "bottom" ? "inset 0 -2px #2563eb" : undefined,
        }}
        className={`group cursor-pointer border-b transition-colors hover:bg-zinc-100/70 ${expanded ? "border-zinc-200" : "border-zinc-100 last:border-0"}${indent ? " bg-zinc-50/40" : ""}${isDragging ? " relative z-10 bg-blue-50/70 opacity-70 outline outline-2 outline-blue-400 outline-offset-[-2px]" : ""}`}
      >
        <td className={`border-r border-zinc-100/80 py-3 w-28 sm:w-32${indent ? " pl-2 sm:pl-8 pr-2 sm:pr-4" : " px-2 sm:px-4"}`}>
          <div className="flex items-center gap-1">
            {canReorder && (
              <button
                type="button"
                draggable={!reorderBusy}
                disabled={reorderBusy}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onClick={() => setSortingOpen((value) => !value)}
                className="flex h-11 w-11 shrink-0 cursor-grab items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-600 active:cursor-grabbing disabled:opacity-50"
                title="拖动排序，或点击上移 / 下移"
                aria-label={`调整顺序：${scene.name || scene.number}`}
                aria-expanded={sortingOpen}
              >
                <svg width="18" height="20" viewBox="0 0 18 20" fill="currentColor" aria-hidden="true">
                  {[4, 10, 16].map((y) => <React.Fragment key={y}><circle cx="6" cy={y} r="1.7" /><circle cx="12" cy={y} r="1.7" /></React.Fragment>)}
                </svg>
              </button>
            )}
            <span className="flex w-4 flex-shrink-0 items-center text-zinc-400 sm:hidden">
              <ChevronIcon direction={expanded ? "down" : "right"} size={12} />
            </span>
            <span className={`text-sm tabular-nums ${indent ? "text-zinc-400" : "font-semibold text-zinc-600"}`}>
              {scene.number || "—"}
            </span>
          </div>
        </td>
        <td className="border-r border-zinc-100/80 px-2 sm:px-4 py-3">
          {editingName ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => commit(draftName.trim())}
              onKeyDown={(e) => { if (e.key === "Enter") commit(draftName.trim()); if (e.key === "Escape") { setDraftName(scene.name); setEditingName(false); } }}
              disabled={saving}
              className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none disabled:opacity-50"
            />
          ) : (
            <span
              onClick={() => canEdit && fieldPerms.name && setEditingName(true)}
              data-scene-editable={canEdit && fieldPerms.name ? "true" : undefined}
              className={`text-sm ${indent ? "text-zinc-500" : "font-medium text-zinc-700"} ${canEdit && fieldPerms.name ? "cursor-text hover:opacity-70" : ""}`}
            >
              {scene.name || <span className="italic text-zinc-300">未命名</span>}
            </span>
          )}
        </td>
        <td className="border-r border-zinc-100/80 px-4 py-3">
          {marks.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {marks.map((m) => (
                <span key={m} className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-zinc-400 bg-zinc-100">
                  {m}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="w-72 px-4 py-3 text-right hidden sm:table-cell">
          <div className="flex h-5 items-center justify-end gap-3">
            {(canEdit && fieldPerms.kind || canDelete) && (
              <span className="inline-flex h-5 items-center">
                <BoundaryActionMenu
                  conversionLabel={scene.kind === "scene" ? "转为章节" : "转为段落"}
                  onConvert={canEdit && fieldPerms.kind ? () => { void onConvert(); } : undefined}
                  onDelete={canDelete ? () => { void del(); } : undefined}
                  deleting={deleting}
                />
              </span>
            )}
            <button
              onClick={toggleExpanded}
              className={`inline-flex h-5 w-5 items-center justify-center transition-all ${expanded ? "text-zinc-500" : "text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-zinc-600"}`}
              title={expanded ? "收起" : "展开详情"}
            >
              <ChevronIcon direction={expanded ? "up" : "down"} />
            </button>
          </div>
        </td>
      </tr>
      {canReorder && sortingOpen && (
        <tr>
          <td colSpan={4} className="border-b border-zinc-200 bg-zinc-50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-600">{scene.kind === "scene" ? "在本章内调整顺序" : "调整章节顺序"}</span>
              <button type="button" disabled={reorderBusy || !canMoveUp} onClick={() => { void onMove("up"); }} aria-label={`上移：${scene.name || scene.number}`} className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-700 disabled:opacity-40">↑ 上移</button>
              <button type="button" disabled={reorderBusy || !canMoveDown} onClick={() => { void onMove("down"); }} aria-label={`下移：${scene.name || scene.number}`} className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-700 disabled:opacity-40">↓ 下移</button>
              <button type="button" onClick={() => setSortingOpen(false)} className="min-h-11 rounded-lg px-3 text-sm text-zinc-600">收起排序</button>
            </div>
          </td>
        </tr>
      )}
      {expanded && (
        <tr className={`border-b border-zinc-100${indent ? " bg-zinc-50/40" : " bg-zinc-50/60"}`}>
          <td colSpan={4} className={`pb-4 pt-2${indent ? " pl-8 pr-4" : " px-4"}`}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">预期时长</label>
                {chapterDurationDisplay ? (
                  <p className="min-h-8 rounded border border-transparent px-2 py-1.5 text-xs text-zinc-600">
                    {chapterDurationDisplay.hasMissingDuration && !(canEdit && fieldPerms.expectedDuration)
                      ? <span className="italic text-zinc-300">—</span>
                      : chapterDurationDisplay.text || <span className="italic text-zinc-300">—</span>}
                  </p>
                ) : (
                  <DurationInput
                    value={parseDuration(scene.expectedDuration)}
                    canEdit={canEdit && fieldPerms.expectedDuration}
                    onSave={async (seconds) => {
                      await onPatchMeta({
                        expectedDuration: seconds != null ? seconds.toString() : ""
                      });
                    }}
                  />
                )}
              </div>
              <div />
              <MetaField
                label="简介"
                value={scene.synopsis}
                multiline
                canEdit={canEdit && fieldPerms.synopsis}
                onSave={(v) => onPatchMeta({ synopsis: v })}
              />
              <MetaField
                label="行动线"
                value={scene.actionLine}
                multiline
                canEdit={canEdit && fieldPerms.actionLine}
                onSave={(v) => onPatchMeta({ actionLine: v })}
              />
              <MetaField
                label="音乐"
                value={scene.music}
                multiline
                canEdit={canEdit && fieldPerms.music}
                onSave={(v) => onPatchMeta({ music: v })}
              />
              <MetaField
                label="舞台呈现"
                value={scene.stageNotes}
                multiline
                canEdit={canEdit && fieldPerms.stageNotes}
                onSave={(v) => onPatchMeta({ stageNotes: v })}
              />
            </div>
            {(canEdit && fieldPerms.kind || canDelete) && (
              <div className="sm:hidden mt-3 pt-3 border-t border-zinc-100 flex items-center gap-4">
                {mobileAction === "convert" ? (
                  <>
                    <button type="button" onClick={() => { void onConvert(); setMobileAction(null); }} className="text-xs text-blue-600/80 hover:text-blue-900/80">
                      {scene.kind === "scene" ? "转为章节" : "转为段落"}
                    </button>
                    <button type="button" onClick={() => setMobileAction(null)} className="text-xs text-zinc-400">取消</button>
                  </>
                ) : mobileAction === "delete" ? (
                  <>
                    <button type="button" onClick={() => { void del(); setMobileAction(null); }} disabled={deleting} className="text-xs text-red-500 disabled:opacity-50">
                      {deleting ? "删除中…" : "确认删除"}
                    </button>
                    <button type="button" onClick={() => setMobileAction(null)} className="text-xs text-zinc-400">取消</button>
                  </>
                ) : (
                  <>
                    {canEdit && fieldPerms.kind && (
                      <button type="button" onClick={() => setMobileAction("convert")} className="text-xs text-zinc-500 hover:text-zinc-700">转换类型</button>
                    )}
                    {canDelete && (
                      <button type="button" onClick={() => setMobileAction("delete")} className="text-xs text-zinc-500 hover:text-red-500">删除</button>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="mt-3 pt-3 border-t border-zinc-100">
              <MountPointAssets
                productionId={productionId}
                mountType="scene"
                mountId={scene.id}
                label={`${scene.number}${scene.name ? ` ${scene.name}` : ""}`}
                /* 挂载有自己的钥匙（scene/<id>/mounts@create），不随字段写权限
                   下发——用 canEdit 这个粗门开合等于「入口亮着、点下去 403」 */
                canEdit={canEdit && canMountScene(fieldPerms, scene.id)}
                display="compact"
                unsavedGuardMessage="请先完成或关闭附件关联窗口"
              />
            </div>
            <div className="mt-3">
              {/* 只读反链展示（引用边）：手动关联文档已并入上方挂载面板的
                  「挂载/新建文档」（#420 第二批，入口去重）——建边动作不再双轨 */}
              <RelatedWikiChips
                productionId={productionId}
                entityType="scene"
                entityId={scene.id}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function InsertSceneRow({
  colSpan,
  onAddChapter,
  onAddScene,
  allowEmptyChapterName = false,
  prominent = false,
}: {
  colSpan: number;
  onAddChapter: ((name: string) => Promise<void>) | null;
  onAddScene: ((name: string) => Promise<void>) | null;
  allowEmptyChapterName?: boolean;
  prominent?: boolean;
}) {
  const [open, setOpen] = useState<"chapter" | "scene" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(null);
      setDraftName("");
      setError(null);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  const submit = async (kind: "chapter" | "scene") => {
    if (!draftName.trim() && !(kind === "chapter" && allowEmptyChapterName)) return;
    const handler = kind === "chapter" ? onAddChapter : onAddScene;
    if (!handler) return;
    setAdding(true);
    setError(null);
    try {
      await handler(draftName.trim());
      setDraftName("");
      setOpen(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <tr className={`group border-b border-zinc-50 ${prominent ? "h-32" : ""}`}>
        <td colSpan={colSpan} className={prominent ? "p-0" : "px-4 py-0"}>
          <div
            ref={panelRef}
            data-dramaturgy-unsaved={open ? "true" : undefined}
            data-dramaturgy-unsaved-message="请先添加或取消正在填写的章节/段落"
            className={`relative flex justify-center ${prominent ? "h-full" : ""}`}
          >
            {!open ? (
              <button
                onClick={() => setOpen(onAddScene ? "scene" : "chapter")}
                className={prominent
                  ? "flex h-full min-h-32 w-full items-center justify-center gap-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-700"
                  : "flex h-6 w-full items-center justify-center gap-1.5 rounded text-[11px] leading-none text-zinc-300 opacity-0 transition-all hover:bg-zinc-100/80 hover:text-zinc-600 group-hover:opacity-100"}
                aria-label="添加章节或场景"
              >
                <span className="text-base leading-none">+</span>
                <span>{prominent ? "暂无章节，点击添加章节/段落" : "添加章节或段落"}</span>
              </button>
            ) : (
              <div className="flex w-full items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1 shadow-sm">
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => { setDraftName(e.target.value); setError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit(open);
                    if (e.key === "Escape") { setOpen(null); setDraftName(""); setError(null); }
                  }}
                  placeholder={open === "chapter" ? "新章节名称" : "新场景名称"}
                  className="min-w-0 flex-1 text-sm text-zinc-700 outline-none placeholder:text-zinc-300"
                />
                {onAddChapter && (
                  <button
                    onClick={() => open === "chapter" ? submit("chapter") : setOpen("chapter")}
                    disabled={adding || (open === "chapter" && !draftName.trim() && !allowEmptyChapterName)}
                    className={`rounded px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-30 ${open === "chapter" ? "bg-zinc-800 text-white hover:bg-zinc-600" : "text-zinc-500 hover:bg-zinc-100"}`}
                  >
                    添加章节
                  </button>
                )}
                {onAddScene && (
                  <button
                    onClick={() => open === "scene" ? submit("scene") : setOpen("scene")}
                    disabled={adding || (open === "scene" && !draftName.trim())}
                    className={`rounded px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50 ${open === "scene" ? "bg-blue-900/80 text-white hover:bg-blue-700/80" : "text-zinc-500 hover:bg-zinc-100"}`}
                  >
                    添加段落
                  </button>
                )}
                <button
                  onClick={() => { setOpen(null); setDraftName(""); setError(null); }}
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                >
                  取消
                </button>
              </div>
            )}
          </div>
        </td>
      </tr>
      {error && (
        <tr><td colSpan={colSpan} className="px-4 pb-2 text-xs text-red-500">{error}</td></tr>
      )}
    </>
  );
}

export default function ScenesManager({ productionId, productionName, initialScenes, openingChapterMarkerId, canEdit, fieldPerms, embedded, canImport, versionId, initialExpandedId, trackWrite }: Props & { canImport?: boolean }) {
  const [scenes, setScenes] = useState<MarkerProjection[]>(initialScenes);
  const [dragging, setDragging] = useState<MarkerProjection | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: "top" | "bottom"; beforeId: string | null } | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const reorderPendingRef = useRef(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [orderUncertain, setOrderUncertain] = useState(false);
  const currentVersionId = versionId ?? null;
  const [deleteDialog, setDeleteDialog] = useState<MarkerDeleteDialogState | null>(null);
  const [deleteDialogBusy, setDeleteDialogBusy] = useState(false);
  const runWrite = trackWrite ?? (async <T,>(operation: Promise<T>) => operation);

  useEffect(() => {
    if (!canEdit) setDeleteDialog(null);
  }, [canEdit]);

  const applyCanonicalPayload = (data: { scenes?: MarkerProjection[] }) => {
    if (data.scenes) setScenes(data.scenes);
  };

  const refreshCanonicalState = useCallback(async () => {
    const query = currentVersionId ? `?versionId=${encodeURIComponent(currentVersionId)}` : "";
    const response = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes${query}`);
    if (!response.ok || response.status === 202) return false;
    const data = await response.json() as MarkerProjection[];
    setScenes(data);
    return true;
  }, [currentVersionId, productionId]);

  // markers 流（#467：后台标签不建连）。debounce timer 挂 ref——连接会随可见性
  // 反复开合，timer 的生命周期比单次连接长。
  const markerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (markerRefreshTimerRef.current) clearTimeout(markerRefreshTimerRef.current);
  }, []);

  useVisibleEventSource(
    currentVersionId
      ? `${BASE_PATH}/api/script/${productionId}/stream?v=${encodeURIComponent(currentVersionId)}`
      : null,
    {
      // 隐藏/断线期间的 markers 帧不补发，重连先无条件对一次账
      onReopen: () => { void refreshCanonicalState(); },
      listeners: {
        markers: () => {
          if (markerRefreshTimerRef.current) clearTimeout(markerRefreshTimerRef.current);
          markerRefreshTimerRef.current = setTimeout(() => {
            markerRefreshTimerRef.current = null;
            void refreshCanonicalState();
          }, 50);
        },
      },
    },
  );

  const mutate = (url: string, init: RequestInit) => runWrite((async () => {
      let res = await fetch(url, init);
      if (res.status === 202) res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "操作失败");
      applyCanonicalPayload(data);
    })());

  const update = async (id: string, name: string) => {
    await mutate(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { name, versionId: currentVersionId } : { name }),
    });
  };

  const patchMeta = async (id: string, fields: Partial<MetaFields>) => {
    await mutate(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { ...fields, versionId: currentVersionId } : fields),
    });
  };

  const convert = async (scene: MarkerProjection) => {
    await mutate(`${BASE_PATH}/api/production/${productionId}/scenes/${scene.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(currentVersionId ? { versionId: currentVersionId } : {}),
        kind: scene.kind === "scene" ? "chapter" : "scene",
      }),
    });
  };

  const deleteRequest = (id: string, operation?: MarkerDeleteOperation["type"]) => fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(currentVersionId ? { versionId: currentVersionId } : {}), ...(operation ? { operation } : {}) }),
  });

  const del = (id: string) => runWrite((async () => {
    let res = await deleteRequest(id);
    if (res.status === 202) res = await deleteRequest(id);
    const data = await res.json().catch(() => ({}));
    if (res.status === 300 && data.plan?.status === "choice") {
      setDeleteDialog({ plan: data.plan });
      return;
    }
    if (res.status === 409 && data.plan?.status === "blocked") {
      setDeleteDialog({ plan: data.plan });
      return;
    }
    if (!res.ok || isUpdatingResponse(data)) {
      setDeleteDialog({ plan: null, message: data.error ?? "删除失败。" });
      return;
    }
      applyCanonicalPayload(data);
    })());

  const chooseDeleteOperation = async (operation: MarkerDeleteOperation) => {
    if (!deleteDialog) return;
    setDeleteDialogBusy(true);
    try {
      await runWrite((async () => {
        const res = await deleteRequest(operation.markerId, operation.type);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "删除失败。");
        applyCanonicalPayload(data);
        setDeleteDialog(null);
      })());
    } catch (error) {
      setDeleteDialog({ plan: null, message: error instanceof Error ? error.message : "删除失败。" });
    } finally {
      setDeleteDialogBusy(false);
    }
  };

  const add = async (name: string, parentId: string | null, target?: { insertBeforeSceneId: string }) => {
    await mutate(`${BASE_PATH}/api/production/${productionId}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { name, parentId, versionId: currentVersionId, ...target } : { name, parentId, ...target }),
    });
  };

  const reorder = async (markerId: string, beforeMarkerId: string | null) => {
    await mutate(`${BASE_PATH}/api/production/${productionId}/scenes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { markerId, beforeMarkerId, versionId: currentVersionId } : { markerId, beforeMarkerId }),
    });
  };

  const acts = scenes.filter((s) => s.kind === "chapter");
  const subScenes = (actId: string) => scenes.filter((s) => s.parentId === actId);
  const beforeMarker = (marker?: MarkerProjection) => marker ? { insertBeforeSceneId: marker.id } : undefined;
  const colSpan = 4;

  /** 某一行下沿对应的落点：下一个同级；本章最后一段则是下一章（章末边界），再往后就是末尾。 */
  const afterEdgeBeforeId = (row: MarkerProjection) => {
    const siblings = row.kind === "chapter" ? acts : subScenes(row.parentId ?? "");
    const index = siblings.findIndex((item) => item.id === row.id);
    return siblings[index + 1]?.id
      ?? (row.kind === "scene" ? acts[acts.findIndex((item) => item.id === row.parentId) + 1]?.id ?? null : null);
  };

  const saveOrder = async (active: MarkerProjection, beforeId: string | null) => {
    if (!canEdit || !fieldPerms.structure || orderUncertain || reorderPendingRef.current || active.id === openingChapterMarkerId) return;
    if (beforeId === active.id || beforeId === afterEdgeBeforeId(active)) return;
    reorderPendingRef.current = true;
    setReorderBusy(true);
    setReorderError(null);
    try {
      await reorder(active.id, beforeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败";
      const restored = await refreshCanonicalState().catch(() => false);
      setOrderUncertain(!restored);
      setReorderError(`顺序未能保存：${message}。${restored ? "已重新读取当前顺序。" : "无法读取当前顺序，请重试读取或刷新页面后再排序。"}`);
    } finally {
      reorderPendingRef.current = false;
      setReorderBusy(false);
    }
  };

  // 悬停和释放都按当前行计算；离开同级行后不能沿用旧落点。
  const positionAt = (target: MarkerProjection, event: React.DragEvent<HTMLTableRowElement>) => {
    if (!dragging || reorderPendingRef.current || orderUncertain || !canEdit || !fieldPerms.structure
      || dragging.id === target.id || dragging.kind !== target.kind || dragging.parentId !== target.parentId) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
    const beforeId = edge === "top" ? target.id : afterEdgeBeforeId(target);
    if ((beforeId !== null && beforeId === openingChapterMarkerId) || beforeId === dragging.id || beforeId === afterEdgeBeforeId(dragging)) return null;
    return { id: target.id, edge: edge as "top" | "bottom", beforeId };
  };

  const dragPosition = (target: MarkerProjection, event: React.DragEvent<HTMLTableRowElement>) => {
    const position = positionAt(target, event);
    setDropTarget(position);
    if (!position) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const drop = (scene: MarkerProjection, event: React.DragEvent<HTMLTableRowElement>) => {
    const active = dragging;
    const target = positionAt(scene, event);
    setDragging(null);
    setDropTarget(null);
    if (!active || !target) return;
    event.preventDefault();
    void saveOrder(active, target.beforeId);
  };

  const dragProps = (scene: MarkerProjection) => {
    const siblings = scene.kind === "chapter" ? acts : subScenes(scene.parentId ?? "");
    const index = siblings.findIndex((item) => item.id === scene.id);
    const canMoveUp = index > 0 && siblings[index - 1].id !== openingChapterMarkerId;
    const canMoveDown = index >= 0 && index < siblings.length - 1;
    return {
      canReorder: canEdit && fieldPerms.structure && scene.id !== openingChapterMarkerId,
      reorderBusy: reorderBusy || orderUncertain,
      canMoveUp,
      canMoveDown,
      onMove: async (direction: "up" | "down") => {
        if (direction === "up" && canMoveUp) await saveOrder(scene, siblings[index - 1].id);
        if (direction === "down" && canMoveDown) await saveOrder(scene, afterEdgeBeforeId(siblings[index + 1]));
      },
      isDragging: dragging?.id === scene.id,
      dropEdge: dropTarget?.id === scene.id ? dropTarget.edge : null,
      onDragStart: (event: React.DragEvent<HTMLElement>) => {
        if (reorderPendingRef.current || orderUncertain) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", scene.id);
        setDropTarget(null);
        setDragging(scene);
      },
      onDragEnd: () => { setDragging(null); setDropTarget(null); },
      onDragOver: (event: React.DragEvent<HTMLTableRowElement>) => dragPosition(scene, event),
      onDrop: (event: React.DragEvent<HTMLTableRowElement>) => drop(scene, event),
    };
  };

  const card = (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {reorderBusy && <p role="status" className="px-4 py-3 text-sm text-zinc-600">正在保存顺序…</p>}
          {reorderError && (
            <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {reorderError}
              {orderUncertain && <button type="button" className="ml-2 min-h-11 underline" onClick={async () => {
                const restored = await refreshCanonicalState().catch(() => false);
                if (restored) { setOrderUncertain(false); setReorderError(null); }
              }}>重试读取顺序</button>}
            </div>
          )}
          {acts.length === 0 ? (
            <div>
              {canEdit && fieldPerms.create && (
                <table className="w-full">
                  <tbody>
                    <InsertSceneRow
                      colSpan={colSpan}
                      onAddChapter={(name) => add(name, null)}
                      onAddScene={null}
                      allowEmptyChapterName
                      prominent
                    />
                  </tbody>
                </table>
              )}
              {!(canEdit && fieldPerms.create) && <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无章节</p>}
            </div>
          ) : (
            <table className="w-full table-auto sm:table-fixed"
              onDragOverCapture={(event) => {
                if (!(event.target as HTMLElement).closest("[data-scene-sort-row]")) setDropTarget(null);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
              }}
              onDrop={() => { setDragging(null); setDropTarget(null); }}
            >
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="border-r border-zinc-100/80 px-2 sm:px-4 py-3 font-medium w-28 sm:w-32">编号</th>
                  <th className="border-r border-zinc-100/80 px-2 sm:px-4 py-3 font-medium">名称</th>
                  <th className="border-r border-zinc-100/80 px-4 py-3 font-medium">排练记号</th>
                  <th className="w-72 px-4 py-3 hidden sm:table-cell" />
                </tr>
              </thead>
              <tbody>
                {canEdit && fieldPerms.create && (
                  <InsertSceneRow
                    colSpan={colSpan}
                    onAddChapter={(name) => add(name, null, beforeMarker(acts[0]))}
                    onAddScene={null}
                    allowEmptyChapterName
                  />
                )}
                {acts.map((act, actIndex) => {
                  const children = subScenes(act.id);
                  const nextAct = acts[actIndex + 1];
                  return (
                    <React.Fragment key={act.id}>
                      <SceneEditRow
                        scene={act}
                        indent={false}
                        marks={act.rehearsalMarks}
                        childScenes={children}
                        canEdit={canEdit}
                        fieldPerms={fieldPerms}
                        canDelete={canEdit && canDeleteScene(fieldPerms, act.id)}
                        productionId={productionId}
                        initialExpanded={act.id === initialExpandedId}
                        onUpdate={(name) => update(act.id, name)}
                        onConvert={() => convert(act)}
                        onDelete={() => del(act.id)}
                        onPatchMeta={(fields) => patchMeta(act.id, fields)}
                        {...dragProps(act)}
                      />
                      {canEdit && fieldPerms.create && (
                        <InsertSceneRow
                          colSpan={colSpan}
                          onAddChapter={(name) => add(name, null, beforeMarker(children[0] ?? nextAct))}
                          onAddScene={(name) => add(name, act.id, beforeMarker(children[0] ?? nextAct))}
                        />
                      )}
                      {children.map((sub, childIndex) => (
                        <React.Fragment key={sub.id}>
                          <SceneEditRow
                            scene={sub}
                            indent={true}
                            marks={sub.rehearsalMarks}
                            canEdit={canEdit}
                            fieldPerms={fieldPerms}
                            canDelete={canEdit && canDeleteScene(fieldPerms, sub.id)}
                            productionId={productionId}
                            initialExpanded={sub.id === initialExpandedId}
                            onUpdate={(name) => update(sub.id, name)}
                            onConvert={() => convert(sub)}
                            onDelete={() => del(sub.id)}
                            onPatchMeta={(fields) => patchMeta(sub.id, fields)}
                            {...dragProps(sub)}
                          />
                          {canEdit && fieldPerms.create && (
                            <InsertSceneRow
                              colSpan={colSpan}
                              onAddChapter={(name) => add(name, null, beforeMarker(children[childIndex + 1] ?? nextAct))}
                              onAddScene={(name) => add(name, act.id, beforeMarker(children[childIndex + 1] ?? nextAct))}
                            />
                          )}
                        </React.Fragment>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

        </div>
  );

  const deleteDialogElement = deleteDialog ? (
    <MarkerDeleteDialog
      state={deleteDialog}
      busy={deleteDialogBusy}
      onChoose={(operation) => { void chooseDeleteOperation(operation); }}
      onClose={() => setDeleteDialog(null)}
    />
  ) : null;

  if (embedded) return <>{card}{deleteDialogElement}</>;

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}/script`} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回剧本
          </Link>
          <div className="text-right flex flex-col items-end gap-1">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Scenes</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
            {canImport && (
              <Link href={`/production/${productionId}/import-scenes`} className="text-xs text-blue-500 hover:underline">
                导入章节信息
              </Link>
            )}
          </div>
        </div>
        {card}
        {deleteDialogElement}
      </div>
    </div>
  );
}
