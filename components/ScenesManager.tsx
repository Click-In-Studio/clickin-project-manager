"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import VersionSelector from "./VersionSelector";
import MountPointAssets from "./assets/MountPointAssets";
import type { SceneDetail, Version } from "@/lib/db";
import DurationInput from "@/components/DurationInput";
import { parseDuration } from "@/lib/duration";
import { withGeneratedSceneNumbers } from "@/lib/script-generated-labels";
import { FIXED_INITIAL_CHAPTER_BLOCK_ID } from "@/lib/script-fixed-markers";

type MetaFields = Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">;

type Props = {
  productionId: string;
  productionName: string;
  initialScenes: SceneDetail[];
  rehearsalMarks: Record<string, string[]>;
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
  canEdit,
  canDelete,
  productionId,
  versionId,
  initialExpanded,
  onUpdate,
  onDelete,
  onPatchMeta,
}: {
  scene: SceneDetail;
  indent: boolean;
  marks: string[];
  canEdit: boolean;
  canDelete: boolean;
  productionId: string;
  versionId: string | null;
  initialExpanded?: boolean;
  onUpdate: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onPatchMeta: (fields: Partial<MetaFields>) => Promise<void>;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const rowRef = useRef<HTMLTableRowElement>(null);

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
              {[...new Set(marks)].map((m) => (
                <span key={m} className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-zinc-400 bg-zinc-100">
                  {m}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-3">
            {canEdit && canDelete && (
              confirmDelete ? (
                <>
                  <button onClick={del} disabled={deleting} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">
                    {deleting ? "删除中…" : "确认"}
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400 hover:text-zinc-600">取消</button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                >
                  删除
                </button>
              )
            )}
            <button
              onClick={toggleExpanded}
              className={`text-xs transition-all ${expanded ? "text-zinc-500" : "text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-zinc-600"}`}
              title={expanded ? "收起" : "展开详情"}
            >
              {expanded ? "⌃" : "⌄"}
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
                <DurationInput
                  value={parseDuration(scene.expectedDuration)}
                  canEdit={canEdit}
                  onSave={async (seconds) => {
                    await onPatchMeta({ 
                      expectedDuration: seconds != null ? seconds.toString() : "" 
                    });
                  }}
                />
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
}: {
  colSpan: number;
  onAddChapter: ((name: string) => Promise<void>) | null;
  onAddScene: ((name: string) => Promise<void>) | null;
}) {
  const [open, setOpen] = useState<"chapter" | "scene" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (kind: "chapter" | "scene") => {
    if (!draftName.trim()) return;
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
        <td colSpan={colSpan} className="px-4 py-1">
          <div className="relative flex justify-center">
            {!open ? (
              <button
                onClick={() => setOpen(onAddScene ? "scene" : "chapter")}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-200 bg-white text-xs leading-none text-zinc-300 opacity-0 shadow-sm transition-all hover:border-zinc-300 hover:text-zinc-600 group-hover:opacity-100"
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
                    disabled={adding || (open === "chapter" && !draftName.trim())}
                    className={`rounded px-2 py-1 text-xs transition-colors disabled:opacity-30 ${open === "chapter" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:bg-zinc-100"}`}
                  >
                    添加章节
                  </button>
                )}
                {onAddScene && (
                  <button
                    onClick={() => open === "scene" ? submit("scene") : setOpen("scene")}
                    disabled={adding || (open === "scene" && !draftName.trim())}
                    className={`rounded px-2 py-1 text-xs transition-colors disabled:opacity-30 ${open === "scene" ? "bg-blue-600 text-white" : "text-zinc-500 hover:bg-zinc-100"}`}
                  >
                    添加场景
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

export default function ScenesManager({ productionId, productionName, initialScenes, rehearsalMarks, canEdit, embedded, canImport, versions, versionId, initialExpandedId }: Props & { canImport?: boolean }) {
  const [scenes, setScenes] = useState<SceneDetail[]>(initialScenes);
  const [marksMap, setMarksMap] = useState<Record<string, string[]>>(rehearsalMarks);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(versionId ?? null);

  const currentVersion = (versions ?? []).find(v => v.id === currentVersionId);
  const effectiveCanEdit = canEdit && (!currentVersionId || !currentVersion || currentVersion.status === "editing" || currentVersion.status === "committed");

  const handleVersionChange = async (vId: string) => {
    const data: { scenes: SceneDetail[]; rehearsalMarks: Record<string, string[]> } =
      await fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${vId}&includeRehearsalMarks=1`).then(r => r.json());
    if (isUpdatingResponse(data)) {
      return;
    }
    setScenes(data.scenes);
    setMarksMap(data.rehearsalMarks);
    setCurrentVersionId(vId);
  };

  const update = async (id: string, name: string) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { name, versionId: currentVersionId } : { name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
    setScenes((prev) => withGeneratedSceneNumbers(prev.map((s) => s.id === id ? { ...s, name } : s)));
  };

  const patchMeta = async (id: string, fields: Partial<MetaFields>) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { ...fields, versionId: currentVersionId } : fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
    setScenes((prev) => prev.map((s) => s.id === id ? { ...s, ...fields } : s));
  };

  const del = async (id: string) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { versionId: currentVersionId } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "删除失败");
    setScenes((prev) => withGeneratedSceneNumbers(prev.filter((s) => s.id !== id && s.parentId !== id)));
  };

  const add = async (name: string, parentId: string | null, target?: { insertBeforeSceneId?: string; insertAfterSceneId?: string }) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { name, parentId, versionId: currentVersionId, ...target } : { name, parentId, ...target }),
    });
    const data = await res.json();
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "添加失败");
    setScenes((prev) => {
      const beforeIndex = target?.insertBeforeSceneId ? prev.findIndex((s) => s.id === target.insertBeforeSceneId) : -1;
      const afterIndex = target?.insertAfterSceneId ? prev.findIndex((s) => s.id === target.insertAfterSceneId) : -1;
      if (beforeIndex >= 0) {
        const next = [...prev];
        next.splice(beforeIndex, 0, data.scene);
        return withGeneratedSceneNumbers(next);
      }
      if (afterIndex >= 0) {
        const next = [...prev];
        next.splice(afterIndex + 1, 0, data.scene);
        return withGeneratedSceneNumbers(next);
      }
      if (parentId) {
        let insertAfter = prev.findIndex((s) => s.id === parentId);
        for (let i = insertAfter + 1; i < prev.length; i++) {
          if (prev[i].parentId === parentId) insertAfter = i;
          else break;
        }
        const next = [...prev];
        next.splice(insertAfter + 1, 0, data.scene);
        return withGeneratedSceneNumbers(next);
      }
      return withGeneratedSceneNumbers([...prev, data.scene]);
    });
  };

  const acts = scenes.filter((s) => s.parentId === null);
  const subScenes = (actId: string) => scenes.filter((s) => s.parentId === actId);
  const orphans = scenes.filter((s) => s.parentId !== null && !scenes.find((a) => a.id === s.parentId));
  const colSpan = 4;

  const card = (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {acts.length === 0 && orphans.length === 0 ? (
            <div>
              <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无章节</p>
              {effectiveCanEdit && (
                <table className="w-full border-t border-zinc-100">
                  <tbody>
                    <InsertSceneRow
                      colSpan={colSpan}
                      onAddChapter={(name) => add(name, null)}
                      onAddScene={null}
                    />
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="px-4 py-3 font-medium w-24">编号</th>
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">排练记号</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {effectiveCanEdit && (
                  <InsertSceneRow
                    colSpan={colSpan}
                    onAddChapter={(name) => add(name, null, acts[0] ? { insertBeforeSceneId: acts[0].id } : undefined)}
                    onAddScene={null}
                  />
                )}
                {acts.map((act) => {
                  const children = subScenes(act.id);
                  const actMarkList: string[] = [];
                  for (const m of marksMap[act.id] ?? []) {
                    if (actMarkList[actMarkList.length - 1] !== m) actMarkList.push(m);
                  }
                  return (
                    <React.Fragment key={act.id}>
                      <SceneEditRow
                        scene={act}
                        indent={false}
                        marks={actMarkList}
                        canEdit={effectiveCanEdit}
                        canDelete={act.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID}
                        productionId={productionId}
                        versionId={currentVersionId}
                        initialExpanded={act.id === initialExpandedId}
                        onUpdate={(name) => update(act.id, name)}
                        onDelete={() => del(act.id)}
                        onPatchMeta={(fields) => patchMeta(act.id, fields)}
                      />
                      {effectiveCanEdit && (
                        <InsertSceneRow
                          colSpan={colSpan}
                          onAddChapter={(name) => add(name, null, { insertAfterSceneId: act.id })}
                          onAddScene={(name) => add(name, act.id, children[0] ? { insertBeforeSceneId: children[0].id } : { insertAfterSceneId: act.id })}
                        />
                      )}
                      {children.map((sub, childIndex) => (
                        <React.Fragment key={sub.id}>
                          <SceneEditRow
                            scene={sub}
                            indent={true}
                            marks={marksMap[sub.id] ?? []}
                            canEdit={effectiveCanEdit}
                            canDelete={sub.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID}
                            productionId={productionId}
                            versionId={currentVersionId}
                            initialExpanded={sub.id === initialExpandedId}
                            onUpdate={(name) => update(sub.id, name)}
                            onDelete={() => del(sub.id)}
                            onPatchMeta={(fields) => patchMeta(sub.id, fields)}
                          />
                          {effectiveCanEdit && (
                            <InsertSceneRow
                              colSpan={colSpan}
                              onAddChapter={(name) => add(name, null, { insertAfterSceneId: sub.id })}
                              onAddScene={(name) => add(name, act.id, children[childIndex + 1] ? { insertBeforeSceneId: children[childIndex + 1].id } : { insertAfterSceneId: sub.id })}
                            />
                          )}
                        </React.Fragment>
                      ))}
                    </React.Fragment>
                  );
                })}
                {orphans.map((s) => (
                  <SceneEditRow
                    key={s.id}
                    scene={s}
                    indent={false}
                    marks={marksMap[s.id] ?? []}
                    canEdit={effectiveCanEdit}
                    canDelete={s.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID}
                    productionId={productionId}
                    versionId={currentVersionId}
                    initialExpanded={s.id === initialExpandedId}
                    onUpdate={(name) => update(s.id, name)}
                    onDelete={() => del(s.id)}
                    onPatchMeta={(fields) => patchMeta(s.id, fields)}
                  />
                ))}
              </tbody>
            </table>
          )}

        </div>
  );

  if (embedded) return card;

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
      </div>
    </div>
  );
}
