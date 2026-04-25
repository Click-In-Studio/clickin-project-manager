"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Character } from "@/lib/script-types";

type Props = {
  productionId: string;
  productionName: string;
  character: Character;
  canEdit: boolean;
};

export default function CharacterDetail({ productionId, productionName, character, canEdit }: Props) {
  const router = useRouter();
  const [name, setName] = useState(character.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === character.name) { setName(character.name); return; }
    setSaving(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${character.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/characters/${character.id}`, {
        method: "DELETE",
      });
      router.push(`/production/${productionId}/script`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href={`/production/${productionId}/script`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回剧本
          </Link>
          <div className="text-right">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Character</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white shadow-sm p-6 space-y-6">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">姓名</label>
            {canEdit ? (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                disabled={saving}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50"
              />
            ) : (
              <p className="text-sm text-zinc-800 py-2">{name}</p>
            )}
          </div>

          {canEdit && (
            <div className="pt-2 border-t border-zinc-100">
              {confirmDelete ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-zinc-500 flex-1">确认删除角色「{character.name}」？</p>
                  <button
                    onClick={del}
                    disabled={deleting}
                    className="rounded-lg bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {deleting ? "删除中…" : "确认"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-sm text-zinc-400 hover:text-zinc-600"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-sm text-red-400 hover:text-red-600 transition-colors"
                >
                  删除角色
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
