"use client";

import React, { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import VersionSelector from "./VersionSelector";
import MountPointAssets from "./assets/MountPointAssets";
import type { SceneDetail, Version } from "@/lib/db";

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
};

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
  productionId,
  versionId,
  onUpdate,
  onDelete,
  onPatchMeta,
}: {
  scene: SceneDetail;
  indent: boolean;
  marks: string[];
  canEdit: boolean;
  productionId: string;
  versionId: string | null;
  onUpdate: (number: string, name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onPatchMeta: (fields: Partial<MetaFields>) => Promise<void>;
}) {
  const [editingNumber, setEditingNumber] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftNumber, setDraftNumber] = useState(scene.number);
  const [draftName, setDraftName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (draftNumber !== scene.number && !editingNumber) setDraftNumber(scene.number);
  if (draftName !== scene.name && !editingName) setDraftName(scene.name);

  const commit = async (number: string, name: string) => {
    setEditingNumber(false);
    setEditingName(false);
    if (number === scene.number && name === scene.name) return;
    setSaving(true);
    try { await onUpdate(number, name); } finally { setSaving(false); }
  };

  const del = async () => {
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <>
      <tr className={`group border-b ${expanded ? "border-zinc-200" : "border-zinc-100 last:border-0"}${indent ? " bg-zinc-50/40" : ""}`}>
        <td className={`py-3 w-24${indent ? " pl-8 pr-4" : " px-4"}`}>
          {editingNumber ? (
            <input
              autoFocus
              value={draftNumber}
              onChange={(e) => setDraftNumber(e.target.value)}
              onBlur={() => commit(draftNumber.trim(), draftName.trim())}
              onKeyDown={(e) => { if (e.key === "Enter") commit(draftNumber.trim(), draftName.trim()); if (e.key === "Escape") { setDraftNumber(scene.number); setEditingNumber(false); } }}
              disabled={saving}
              className="w-full border-b border-zinc-400 text-sm outline-none disabled:opacity-50"
            />
          ) : (
            <span
              onClick={() => canEdit && setEditingNumber(true)}
              className={`text-sm ${indent ? "text-zinc-400" : "font-semibold text-zinc-600"} ${canEdit ? "cursor-text hover:opacity-70" : ""}`}
            >
              {scene.number || "—"}
            </span>
          )}
        </td>
        <td className="px-4 py-3">
          {editingName ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => commit(draftNumber.trim(), draftName.trim())}
              onKeyDown={(e) => { if (e.key === "Enter") commit(draftNumber.trim(), draftName.trim()); if (e.key === "Escape") { setDraftName(scene.name); setEditingName(false); } }}
              disabled={saving}
              className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none disabled:opacity-50"
            />
          ) : (
            <span
              onClick={() => canEdit && setEditingName(true)}
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
            {canEdit && (
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
              onClick={() => setExpanded((v) => !v)}
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
              <MetaField
                label="预期时长"
                value={scene.expectedDuration}
                canEdit={canEdit}
                onSave={(v) => onPatchMeta({ expectedDuration: v })}
              />
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

function AddSceneRow({
  indent,
  placeholder,
  colSpan,
  onAdd,
}: {
  indent: boolean;
  placeholder: string;
  colSpan: number;
  onAdd: (number: string, name: string) => Promise<void>;
}) {
  const [draftNumber, setDraftNumber] = useState("");
  const [draftName, setDraftName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!draftNumber.trim() && !draftName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd(draftNumber.trim(), draftName.trim());
      setDraftNumber("");
      setDraftName("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <tr className={indent ? "bg-zinc-50/40" : ""}>
        <td className={`pb-2 w-24${indent ? " pl-8 pr-4" : " px-4"}`}>
          <input
            value={draftNumber}
            onChange={(e) => { setDraftNumber(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="编号"
            className="w-full text-sm text-zinc-700 outline-none placeholder:text-zinc-300 border-b border-zinc-200 focus:border-zinc-400"
          />
        </td>
        <td className="px-4 pb-2">
          <input
            value={draftName}
            onChange={(e) => { setDraftName(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={placeholder}
            className="w-full text-sm text-zinc-700 outline-none placeholder:text-zinc-300 border-b border-zinc-200 focus:border-zinc-400"
          />
        </td>
        <td colSpan={colSpan - 2} className="px-4 pb-2 text-right">
          <button
            onClick={submit}
            disabled={(!draftNumber.trim() && !draftName.trim()) || adding}
            className="text-xs text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors"
          >
            {adding ? "…" : "+ 添加"}
          </button>
        </td>
      </tr>
      {error && (
        <tr><td colSpan={colSpan} className="px-4 pb-2 text-xs text-red-500">{error}</td></tr>
      )}
    </>
  );
}

export default function ScenesManager({ productionId, productionName, initialScenes, rehearsalMarks, canEdit, embedded, canImport, versions, versionId }: Props & { canImport?: boolean }) {
  const [scenes, setScenes] = useState<SceneDetail[]>(initialScenes);
  const [marksMap, setMarksMap] = useState<Record<string, string[]>>(rehearsalMarks);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(versionId ?? null);

  const currentVersion = (versions ?? []).find(v => v.id === currentVersionId);
  const effectiveCanEdit = canEdit && (!currentVersionId || !currentVersion || currentVersion.status === "editing" || currentVersion.status === "committed");

  const handleVersionChange = async (vId: string) => {
    const data: SceneDetail[] = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${vId}`).then(r => r.json());
    setScenes(data);
    setMarksMap({});
    setCurrentVersionId(vId);
  };

  const update = async (id: string, number: string, name: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, name }),
    });
    setScenes((prev) => prev.map((s) => s.id === id ? { ...s, number, name } : s));
  };

  const patchMeta = async (id: string, fields: Partial<MetaFields>) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { ...fields, versionId: currentVersionId } : fields),
    });
    setScenes((prev) => prev.map((s) => s.id === id ? { ...s, ...fields } : s));
  };

  const del = async (id: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, { method: "DELETE" });
    setScenes((prev) => prev.filter((s) => s.id !== id && s.parentId !== id));
  };

  const add = async (number: string, name: string, parentId: string | null) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, name, parentId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "添加失败");
    setScenes((prev) => {
      if (parentId) {
        let insertAfter = prev.findIndex((s) => s.id === parentId);
        for (let i = insertAfter + 1; i < prev.length; i++) {
          if (prev[i].parentId === parentId) insertAfter = i;
          else break;
        }
        const next = [...prev];
        next.splice(insertAfter + 1, 0, data.scene);
        return next;
      }
      return [...prev, data.scene];
    });
  };

  const acts = scenes.filter((s) => s.parentId === null);
  const subScenes = (actId: string) => scenes.filter((s) => s.parentId === actId);
  const orphans = scenes.filter((s) => s.parentId !== null && !scenes.find((a) => a.id === s.parentId));
  const colSpan = 4;

  const card = (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {acts.length === 0 && orphans.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无章节</p>
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
                        productionId={productionId}
                        versionId={currentVersionId}
                        onUpdate={(number, name) => update(act.id, number, name)}
                        onDelete={() => del(act.id)}
                        onPatchMeta={(fields) => patchMeta(act.id, fields)}
                      />
                      {children.map((sub) => (
                        <SceneEditRow
                          key={sub.id}
                          scene={sub}
                          indent={true}
                          marks={marksMap[sub.id] ?? []}
                          canEdit={effectiveCanEdit}
                          productionId={productionId}
                          versionId={currentVersionId}
                          onUpdate={(number, name) => update(sub.id, number, name)}
                          onDelete={() => del(sub.id)}
                          onPatchMeta={(fields) => patchMeta(sub.id, fields)}
                        />
                      ))}
                      {effectiveCanEdit && (
                        <AddSceneRow
                          indent={true}
                          placeholder={`在「${act.number || act.name}」下添加场景…`}
                          colSpan={colSpan}
                          onAdd={(number, name) => add(number, name, act.id)}
                        />
                      )}
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
                    productionId={productionId}
                    versionId={currentVersionId}
                    onUpdate={(number, name) => update(s.id, number, name)}
                    onDelete={() => del(s.id)}
                    onPatchMeta={(fields) => patchMeta(s.id, fields)}
                  />
                ))}
              </tbody>
            </table>
          )}

          {effectiveCanEdit && (
            <div className="border-t border-zinc-100">
              <table className="w-full">
                <tbody>
                  <AddSceneRow
                    indent={false}
                    placeholder="添加幕…"
                    colSpan={colSpan}
                    onAdd={(number, name) => add(number, name, null)}
                  />
                </tbody>
              </table>
            </div>
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
