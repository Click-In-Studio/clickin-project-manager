"use client";

import { useState } from "react";
import type { MarkerProjection } from "@/lib/script/script-marker-domain";
import { canDeleteScene, type SceneFieldPerms } from "@/lib/script/scene-field-perms-shared";
import ScriptDialog, { SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS, SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS } from "./ScriptDialog";
import MarkerDeleteDialog from "./MarkerDeleteDialog";
import type { useSceneTableStructure } from "./use-scene-table-structure";

type Structure = ReturnType<typeof useSceneTableStructure>;
type Insert = { parentId: string | null; beforeId: string | null; label: string };

export default function SceneTableActions({ marker, scenes, fieldPerms, structure, onClose }: {
  marker: MarkerProjection | null;
  scenes: MarkerProjection[];
  fieldPerms: SceneFieldPerms;
  structure: Structure;
  onClose: () => void;
}) {
  const [insert, setInsert] = useState<Insert | null>(marker ? null : {
    parentId: null, beforeId: null, label: "新增章节",
  });
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const label = marker ? `${marker.number} ${marker.name || "未命名"}` : "表格";
  const next = marker ? structure.afterId(marker) : null;
  const close = () => { if (!structure.busy) onClose(); };
  const perform = async (operation: Promise<void>) => {
    try { await operation; onClose(); } catch { /* 错误在表格提示区显示，保留当前输入供重试。 */ }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!insert || !name.trim() || structure.busy || structure.writeBlocked) return;
    void perform(structure.add(name.trim(), insert.parentId, insert.beforeId));
  };
  const items: { label: string; reason: string | null; run: () => void }[] = [
    {
      label: marker?.kind === "scene" ? "在此段落前新增段落" : "在章首新增段落",
      reason: !fieldPerms.create ? "没有创建权限" : !marker ? "请先创建章节" : null,
      run: () => setInsert({
        parentId: marker?.kind === "chapter" ? marker.id : marker?.parentId ?? null,
        beforeId: marker?.kind === "chapter" ? scenes.find(item => item.parentId === marker.id)?.id ?? next : marker?.id ?? null,
        label: marker?.kind === "scene" ? `在 ${label} 前新增段落` : `在 ${label} 章首新增段落`,
      }),
    },
    {
      label: marker?.kind === "scene" ? "在此段落后新增段落" : "在章末新增段落",
      reason: !fieldPerms.create ? "没有创建权限" : !marker ? "请先创建章节" : null,
      run: () => setInsert({ parentId: marker?.kind === "chapter" ? marker.id : marker?.parentId ?? null, beforeId: next, label: `在 ${label} 后新增段落` }),
    },
    {
      label: marker ? "在此位置后新增章节" : "新增章节",
      reason: !fieldPerms.create ? "没有创建权限" : null,
      run: () => setInsert({ parentId: null, beforeId: next, label: marker ? `在 ${label} 后新增章节` : "新增章节" }),
    },
    ...(["up", "down"] as const).map(direction => ({
      label: direction === "up" ? "上移" : "下移",
      reason: !fieldPerms.structure ? "没有排序权限" : !marker || structure.stepBefore(marker, direction) === undefined ? "已到边界或属于固定开场章节" : null,
      run: () => {
        if (!marker) return;
        const beforeId = structure.stepBefore(marker, direction);
        if (beforeId !== undefined) void perform(structure.reorder(marker.id, beforeId));
      },
    })),
    {
      label: "删除",
      reason: !marker ? "请选择章节或段落" : !canDeleteScene(fieldPerms, marker.id) ? "没有此章节或段落的删除权限" : null,
      run: () => setConfirmDelete(true),
    },
  ];

  return (
    <ScriptDialog onClose={close} overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" panelClassName="w-[380px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl bg-white p-4 shadow-xl">
      <div data-dramaturgy-unsaved={insert ? "true" : undefined} data-dramaturgy-unsaved-message="请先添加或取消正在填写的章节/段落">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="min-w-0 break-words text-sm font-semibold">{insert?.label ?? (confirmDelete ? `确认删除 ${label}？` : `${label} · 行操作`)}</h2>
          <button type="button" disabled={structure.busy} onClick={close} aria-label="关闭行操作" className="h-8 w-8 shrink-0 rounded text-zinc-500 hover:bg-zinc-100">×</button>
        </div>
        {structure.error && <p role="alert" className="mb-3 text-xs text-red-700">{structure.error}</p>}
        {insert ? (
          <form onSubmit={submit}>
            <label className="block text-xs text-zinc-600">{insert.parentId ? "段落名称" : "章节名称"}
              <input autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={structure.busy} className="mt-2 w-full rounded border border-zinc-300 px-3 py-2 text-sm" />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={structure.busy} onClick={close} className={SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS}>取消</button>
              <button type="submit" disabled={structure.busy || structure.writeBlocked || !name.trim()} className={`${SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS} disabled:opacity-50`}>{structure.busy ? "添加中…" : "添加"}</button>
            </div>
          </form>
        ) : confirmDelete ? (
          <>
            <p className="text-xs leading-6 text-zinc-500">将按现有章节和段落规则删除；有构作详情时会提示不可删除，有下属空段落时会询问保留方式。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={structure.busy} onClick={close} className={SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS}>取消</button>
              <button type="button" disabled={structure.busy || structure.writeBlocked} onClick={() => { if (marker) void perform(structure.remove(marker.id)); }} className={SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS}>{structure.busy ? "删除中…" : "确认删除"}</button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map(item => {
              const reason = structure.busy ? "请等待当前操作完成" : structure.writeBlocked ? "请先重试同步" : item.reason;
              return <button key={item.label} type="button" aria-disabled={!!reason} title={reason ?? undefined} onClick={() => { if (!reason) item.run(); }} className={`rounded px-3 py-2 text-left text-sm ${reason ? "text-zinc-400" : "text-zinc-700 hover:bg-zinc-100"}`}>{item.label}{reason && <span className="mt-1 block text-[11px]">{reason}</span>}</button>;
            })}
          </div>
        )}
      </div>
    </ScriptDialog>
  );
}

export function SceneTableDeleteDialog({ structure }: { structure: Structure }) {
  if (!structure.deleteDialog) return null;
  return <MarkerDeleteDialog state={structure.deleteDialog} busy={structure.busy} onClose={() => { if (!structure.busy) structure.setDeleteDialog(null); }} onChoose={operation => { void structure.remove(operation.markerId, operation.type).catch(() => {}); }} />;
}
