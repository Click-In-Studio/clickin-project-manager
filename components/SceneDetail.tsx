"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Scene } from "@/lib/script-types";

type Props = {
  productionId: string;
  productionName: string;
  scene: Scene;
  canEdit: boolean;
};

export default function SceneDetail({ productionId, productionName, scene, canEdit }: Props) {
  const router = useRouter();
  const [number, setNumber] = useState(scene.number);
  const [name, setName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async (nextNumber: string, nextName: string) => {
    if (nextNumber === scene.number && nextName === scene.name) return;
    setSaving(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: nextNumber, name: nextName }),
      });
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${scene.id}`, {
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
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Scene</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-white shadow-sm p-6 space-y-5">
          <div className="flex gap-4">
            <div className="w-24 space-y-1.5 shrink-0">
              <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">编号</label>
              {canEdit ? (
                <input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  onBlur={() => save(number.trim(), name.trim())}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  disabled={saving}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50"
                />
              ) : (
                <p className="text-sm text-zinc-800 py-2">{number || "—"}</p>
              )}
            </div>
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">名称</label>
              {canEdit ? (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => save(number.trim(), name.trim())}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  disabled={saving}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50"
                />
              ) : (
                <p className="text-sm text-zinc-800 py-2">{name || "—"}</p>
              )}
            </div>
          </div>

          {canEdit && (
            <div className="pt-2 border-t border-zinc-100">
              {confirmDelete ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-zinc-500 flex-1">
                    确认删除章节「{scene.number}{scene.name ? ` ${scene.name}` : ""}」？
                  </p>
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
                  删除章节
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
