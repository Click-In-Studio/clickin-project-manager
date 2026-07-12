"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import VersionSelector from "./VersionSelector";
import MountPointAssets from "./assets/MountPointAssets";
import type { SceneDetail, Version } from "@/lib/db";
import DurationInput from "@/components/DurationInput";
import { parseDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/scene-duration";
import BoundaryActionMenu from "@/components/BoundaryActionMenu";
import MarkerDeleteDialog, { type MarkerDeleteDialogState } from "@/components/MarkerDeleteDialog";
import type { MarkerDeleteOperation, MarkerProjection } from "@/lib/script-marker-domain";

type MetaFields = Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">;

type Props = {
  productionId: string;
  productionName: string;
  initialScenes: MarkerProjection[];
  canEdit: boolean;
  embedded?: boolean;
  versions?: Version[];
  versionId?: string | null;
  initialExpandedId?: string;
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
    try { await onSave(draft); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-1">
      <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">{label}</label>
      {canEdit ? (
        multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={2}
            className="w-full rounded border border-zinc-200 px-2 py-1.5 text-xs leading-relaxed outline-none resize-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300"
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
  canDelete,
  productionId,
  versionId,
  initialExpanded,
  onUpdate,
  onConvert,
  onDelete,
  onPatchMeta,
}: {
  scene: MarkerProjection;
  indent: boolean;
  marks: string[];
  childScenes?: MarkerProjection[];
  canEdit: boolean;
  canDelete: boolean;
  productionId: string;
  versionId: string | null;
  initialExpanded?: boolean;
  onUpdate: (name: string) => Promise<void>;
  onConvert: () => Promise<void>;
  onDelete: () => Promise<void>;
  onPatchMeta: (fields: Partial<MetaFields>) => Promise<void>;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const chapterDurationDisplay = expanded && childScenes
    ? getChapterDurationDisplay(childScenes)
    : null;

  useEffect(() => {
    if (initialExpanded && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (draftName !== scene.name && !editingName) setDraftName(scene.name);

  const commit = async (name: string) => {
    setEditingName(false);
    if (name === scene.name) return;
    setSaving(true);
    try { await onUpdate(name); } finally { setSaving(false); }
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
        onClick={handleRowClick}
        className={`group cursor-pointer border-b ${expanded ? "border-zinc-200" : "border-zinc-100 last:border-0"}${indent ? " bg-zinc-50/40" : ""}`}
      >
        <td className={`py-3 w-24${indent ? " pl-8 pr-4" : " px-4"}`}>
          <span className={`text-sm tabular-nums ${indent ? "text-zinc-400" : "font-semibold text-zinc-600"}`}>
            {scene.number || "—"}
          </span>
        </td>
        <td className="px-4 py-3">
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
              onClick={() => canEdit && setEditingName(true)}
              data-scene-editable={canEdit ? "true" : undefined}
              className={`text-sm ${indent ? "text-zinc-500" : "font-medium text-zinc-700"} ${canEdit ? "cursor-text hover:opacity-70" : ""}`}
            >
              {scene.name || <span className="italic text-zinc-300">未命名</span>}
            </span>
          )}
        </td>
        <td className="px-4 py-3">
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
        <td className="w-72 px-4 py-3 text-right">
          <div className="flex h-5 items-center justify-end gap-3">
            {canEdit && (
              <span className="inline-flex h-5 items-center">
                <BoundaryActionMenu
                  conversionLabel={scene.kind === "scene" ? "转为章节" : "转为段落"}
                  onConvert={() => { void onConvert(); }}
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
              <svg className="h-4 w-4" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <polyline
                  points={expanded ? "3 7.5 6 4.5 9 7.5" : "3 4.5 6 7.5 9 4.5"}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                />
              </svg>
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className={`border-b border-zinc-100${indent ? " bg-zinc-50/40" : " bg-zinc-50/60"}`}>
          <td colSpan={4} className={`pb-4 pt-2${indent ? " pl-8 pr-4" : " px-4"}`}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">预期时长</label>
                {chapterDurationDisplay ? (
                  <p className="min-h-[1.25rem] rounded border border-transparent px-2 py-1 text-xs text-zinc-600">
                    {chapterDurationDisplay.hasMissingDuration && !canEdit
                      ? <span className="italic text-zinc-300">—</span>
                      : chapterDurationDisplay.text || <span className="italic text-zinc-300">—</span>}
                  </p>
                ) : (
                  <DurationInput
                    value={parseDuration(scene.expectedDuration)}
                    canEdit={canEdit}
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
                canEdit={canEdit}
                onSave={(v) => onPatchMeta({ synopsis: v })}
              />
              <MetaField
                label="行动线"
                value={scene.actionLine}
                multiline
                canEdit={canEdit}
                onSave={(v) => onPatchMeta({ actionLine: v })}
              />
              <MetaField
                label="音乐"
                value={scene.music}
                multiline
                canEdit={canEdit}
                onSave={(v) => onPatchMeta({ music: v })}
              />
              <MetaField
                label="舞台呈现"
                value={scene.stageNotes}
                multiline
                canEdit={canEdit}
                onSave={(v) => onPatchMeta({ stageNotes: v })}
              />
            </div>
            <div className="mt-3 pt-3 border-t border-zinc-100">
              <MountPointAssets
                productionId={productionId}
                mountType="scene"
                mountId={scene.id}
                label={`${scene.number}${scene.name ? ` ${scene.name}` : ""}`}
                canEdit={canEdit}
                versionId={versionId}
                display="compact"
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
}: {
  colSpan: number;
  onAddChapter: ((name: string) => Promise<void>) | null;
  onAddScene: ((name: string) => Promise<void>) | null;
  allowEmptyChapterName?: boolean;
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
      <tr className="group border-b border-zinc-50">
        <td colSpan={colSpan} className="px-4 py-0">
          <div ref={panelRef} className="relative flex justify-center">
            {!open ? (
              <button
                onClick={() => setOpen(onAddScene ? "scene" : "chapter")}
                className="flex h-4 w-5 items-center justify-center rounded-full text-[11px] leading-none text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-500 group-hover:opacity-100"
                aria-label="添加章节或场景"
              >
                +
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

export default function ScenesManager({ productionId, productionName, initialScenes, canEdit, embedded, canImport, versions, versionId, initialExpandedId }: Props & { canImport?: boolean }) {
  const [scenes, setScenes] = useState<MarkerProjection[]>(initialScenes);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(versionId ?? null);
  const [deleteDialog, setDeleteDialog] = useState<MarkerDeleteDialogState | null>(null);
  const [deleteDialogBusy, setDeleteDialogBusy] = useState(false);

  const currentVersion = (versions ?? []).find(v => v.id === currentVersionId);
  const effectiveCanEdit = canEdit && (!currentVersionId || !currentVersion || currentVersion.status === "editing" || currentVersion.status === "committed");

  const handleVersionChange = async (vId: string) => {
    const data: MarkerProjection[] =
      await fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${vId}`).then(r => r.json());
    if (isUpdatingResponse(data)) {
      return;
    }
    setScenes(data);
    setCurrentVersionId(vId);
  };

  const applyCanonicalPayload = (data: { scenes?: MarkerProjection[] }) => {
    if (data.scenes) setScenes(data.scenes);
  };

  const refreshCanonicalState = useCallback(async () => {
    const query = currentVersionId ? `?versionId=${encodeURIComponent(currentVersionId)}` : "";
    const response = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes${query}`);
    if (!response.ok || response.status === 202) return;
    const data = await response.json() as MarkerProjection[];
    setScenes(data);
  }, [currentVersionId, productionId]);

  useEffect(() => {
    if (!currentVersionId) return;
    const stream = new EventSource(`${BASE_PATH}/api/script/${productionId}/stream?v=${encodeURIComponent(currentVersionId)}`);
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const handleMarkers = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refreshCanonicalState(); }, 50);
    };
    stream.addEventListener("markers", handleMarkers);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      stream.removeEventListener("markers", handleMarkers);
      stream.close();
    };
  }, [currentVersionId, productionId, refreshCanonicalState]);

  const mutate = async (url: string, init: RequestInit) => {
    let res = await fetch(url, init);
    if (res.status === 202) res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "操作失败");
    applyCanonicalPayload(data);
  };

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

  const del = async (id: string) => {
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
  };

  const chooseDeleteOperation = async (operation: MarkerDeleteOperation) => {
    if (!deleteDialog) return;
    setDeleteDialogBusy(true);
    try {
      const res = await deleteRequest(operation.markerId, operation.type);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || isUpdatingResponse(data)) {
        setDeleteDialog({ plan: null, message: data.error ?? "删除失败。" });
        return;
      }
      applyCanonicalPayload(data);
      setDeleteDialog(null);
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

  const acts = scenes.filter((s) => s.kind === "chapter");
  const subScenes = (actId: string) => scenes.filter((s) => s.parentId === actId);
  const beforeMarker = (marker?: MarkerProjection) => marker ? { insertBeforeSceneId: marker.id } : undefined;
  const colSpan = 4;

  const card = (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {acts.length === 0 ? (
            <div>
              <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无章节</p>
              {effectiveCanEdit && (
                <table className="w-full border-t border-zinc-100">
                  <tbody>
                    <InsertSceneRow
                      colSpan={colSpan}
                      onAddChapter={(name) => add(name, null)}
                      onAddScene={null}
                      allowEmptyChapterName
                    />
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <table className="w-full table-fixed">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="px-4 py-3 font-medium w-24">编号</th>
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">排练记号</th>
                  <th className="w-72 px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {effectiveCanEdit && (
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
                        canEdit={effectiveCanEdit}
                        canDelete
                        productionId={productionId}
                        versionId={currentVersionId}
                        initialExpanded={act.id === initialExpandedId}
                        onUpdate={(name) => update(act.id, name)}
                        onConvert={() => convert(act)}
                        onDelete={() => del(act.id)}
                        onPatchMeta={(fields) => patchMeta(act.id, fields)}
                      />
                      {effectiveCanEdit && (
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
                            canEdit={effectiveCanEdit}
                            canDelete
                            productionId={productionId}
                            versionId={currentVersionId}
                            initialExpanded={sub.id === initialExpandedId}
                            onUpdate={(name) => update(sub.id, name)}
                            onConvert={() => convert(sub)}
                            onDelete={() => del(sub.id)}
                            onPatchMeta={(fields) => patchMeta(sub.id, fields)}
                          />
                          {effectiveCanEdit && (
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
            {versions && versions.length > 0 && (
              <VersionSelector
                productionId={productionId}
                versions={versions}
                currentVersionId={currentVersionId}
                canManage={canEdit}
                onChange={handleVersionChange}
              />
            )}
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
