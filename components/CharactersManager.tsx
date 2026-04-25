"use client";

import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Character } from "@/lib/script-types";

type Props = {
  productionId: string;
  productionName: string;
  initialCharacters: Character[];
  canEdit: boolean;
};

function CharacterEditRow({
  char,
  canEdit,
  onRename,
  onDelete,
}: {
  char: Character;
  canEdit: boolean;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(char.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const commit = async () => {
    const t = draft.trim();
    if (!t || t === char.name) { setDraft(char.name); setEditing(false); return; }
    setSaving(true);
    try { await onRename(t); } finally { setSaving(false); setEditing(false); }
  };

  const del = async () => {
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <tr className="group border-b border-zinc-100 last:border-0">
      <td className="px-4 py-3">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(char.name); setEditing(false); } }}
            disabled={saving}
            className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none disabled:opacity-50"
          />
        ) : (
          <span
            onClick={() => canEdit && setEditing(true)}
            className={`text-sm text-zinc-700 ${canEdit ? "cursor-text hover:text-zinc-900" : ""}`}
          >
            {char.name}
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

export default function CharactersManager({ productionId, productionName, initialCharacters, canEdit }: Props) {
  const [characters, setCharacters] = useState<Character[]>(initialCharacters);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async (id: string, name: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setCharacters((prev) => prev.map((c) => c.id === id ? { ...c, name } : c));
  };

  const del = async (id: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${id}`, { method: "DELETE" });
    setCharacters((prev) => prev.filter((c) => c.id !== id));
  };

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "添加失败"); return; }
      setCharacters((prev) => [...prev, data.char]);
      setDraft("");
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
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Characters</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          {characters.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-300">暂无角色</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                  <th className="px-4 py-3 font-medium">姓名</th>
                  {canEdit && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {characters.map((c) => (
                  <CharacterEditRow
                    key={c.id}
                    char={c}
                    canEdit={canEdit}
                    onRename={(name) => rename(c.id, name)}
                    onDelete={() => del(c.id)}
                  />
                ))}
              </tbody>
            </table>
          )}

          {canEdit && (
            <div className="border-t border-zinc-100 px-4 py-3 flex items-center gap-3">
              <input
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setError(null); }}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="新角色名…"
                className="min-w-0 flex-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-300"
              />
              <button
                onClick={add}
                disabled={!draft.trim() || adding}
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
