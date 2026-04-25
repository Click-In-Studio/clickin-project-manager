"use client";

import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Scene } from "@/lib/script-types";

type Props = {
  productionId: string;
  productionName: string;
  initialScenes: Scene[];
  canEdit: boolean;
};

function SceneEditRow({
  scene,
  canEdit,
  onUpdate,
  onDelete,
}: {
  scene: Scene;
  canEdit: boolean;
  onUpdate: (number: string, name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editingNumber, setEditingNumber] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftNumber, setDraftNumber] = useState(scene.number);
  const [draftName, setDraftName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const commit = async (number: string, name: string) => {
    if (number === scene.number && name === scene.name) {
      setEditingNumber(false); setEditingName(false);
      return;
    }
    setSaving(true);
    try { await onUpdate(number, name); } finally { setSaving(false); setEditingNumber(false); setEditingName(false); }
  };

  const del = async () => {
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <tr className="group border-b border-zinc-100 last:border-0">
      <td className="px-4 py-3 w-24">
        {editingNumber ? (
          <input
            autoFocus
            value={draftNumber}
            onChange={(e) => setDraftNumber(e.target.value)}
            onBlur={() => commit(draftNumber.trim(), draftName.trim())}
            onKeyDown={(e) => { if (e.key === "Enter") commit(draftNumber.trim(), draftName.trim()); if (e.key === "Escape") { setDraftNumber(scene.number); setEditingNumber(false); } }}
            disabled={saving}
            className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none disabled:opacity-50"
          />
        ) : (
          <span
            onClick={() => canEdit && setEditingNumber(true)}
            className={`text-sm text-zinc-500 ${canEdit ? "cursor-text hover:text-zinc-800" : ""}`}
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
            className={`text-sm text-zinc-700 ${canEdit ? "cursor-text hover:text-zinc-900" : ""}`}
          >
            {scene.name || "—"}
          </span>
        )}
      </td>
      {canEdit && (
        <td className="px-4 py-3 text-right">
          {confirmDelete ? (
            <span className="flex items-center justify-end gap-2">
              <button onClick={del} disabled={deleting} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">
                {deleting ? "删除中…" : "确认"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400 hover:text-zinc-600">取消</button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
            >
              删除
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

export default function ScenesManager({ productionId, productionName, initialScenes, canEdit }: Props) {
  const [scenes, setScenes] = useState<Scene[]>(initialScenes);
  const [draftNumber, setDraftNumber] = useState("");
  const [draftName, setDraftName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (id: string, number: string, name: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, name }),
    });
    setScenes((prev) => prev.map((s) => s.id === id ? { ...s, number, name } : s));
  };

  const del = async (id: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, { method: "DELETE" });
    setScenes((prev) => prev.filter((s) => s.id !== id));
  };

  const add = async () => {
    if (!draftNumber.trim() && !draftName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: draftNumber.trim(), name: draftName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "添加失败"); return; }
      setScenes((prev) => [...prev, data.scene]);
      setDraftNumber("");
      setDraftName("");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}/script`} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回剧本
          </Link>
          <div className="text-right">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Scenes</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {scenes.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无章节</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="px-4 py-3 font-medium w-24">编号</th>
                  <th className="px-4 py-3 font-medium">名称</th>
                  {canEdit && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {scenes.map((s) => (
                  <SceneEditRow
                    key={s.id}
                    scene={s}
                    canEdit={canEdit}
                    onUpdate={(number, name) => update(s.id, number, name)}
                    onDelete={() => del(s.id)}
                  />
                ))}
              </tbody>
            </table>
          )}

          {canEdit && (
            <div className="border-t border-zinc-100 px-4 py-3 flex items-center gap-3">
              <input
                value={draftNumber}
                onChange={(e) => { setDraftNumber(e.target.value); setError(null); }}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="编号"
                className="w-20 shrink-0 text-sm text-zinc-800 outline-none placeholder:text-zinc-300"
              />
              <input
                value={draftName}
                onChange={(e) => { setDraftName(e.target.value); setError(null); }}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="名称"
                className="min-w-0 flex-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-300"
              />
              <button
                onClick={add}
                disabled={(!draftNumber.trim() && !draftName.trim()) || adding}
                className="shrink-0 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-30"
              >
                {adding ? "添加中…" : "添加"}
              </button>
            </div>
          )}
          {error && <p className="px-4 pb-3 text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
