"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { SceneDetail } from "@/lib/db";
import MountPointAssets from "@/components/assets/MountPointAssets";
import DurationInput from "@/components/DurationInput";
import { parseDurationSafe, parseDuration } from "@/lib/duration";

type Props = {
  productionId: string;
  productionName: string;
  scene: SceneDetail;
  canEdit: boolean;
  versionId?: string | null;
};

function isUpdatingResponse(payload: unknown): payload is { status: "updating" } {
  return typeof payload === "object" && payload !== null && "status" in payload && payload.status === "updating";
}

function Field({
  label,
  value,
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
  const [draft, setDraft] = useState(value);
  const [lastSeen, setLastSeen] = useState(value);
  const [saving, setSaving] = useState(false);

  if (lastSeen !== value) { setLastSeen(value); setDraft(value); }

  const commit = async () => {
    if (draft === value) return;
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">{label}</label>
      {canEdit ? (
        multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={3}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm leading-relaxed outline-none resize-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300"
            placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300"
            placeholder="—"
          />
        )
      ) : (
        <p className="text-sm text-zinc-700 py-1 whitespace-pre-wrap">{value || <span className="text-zinc-300 italic">—</span>}</p>
      )}
    </div>
  );
}

export default function SceneDetailView({ productionId, productionName, scene, canEdit, versionId }: Props) {
  const router = useRouter();
  const [number, setNumber] = useState(scene.number);
  const [name, setName] = useState(scene.name);
  const [lastSeenNumber, setLastSeenNumber] = useState(scene.number);
  const [lastSeenName, setLastSeenName] = useState(scene.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (lastSeenNumber !== scene.number) { setLastSeenNumber(scene.number); setNumber(scene.number); }
  if (lastSeenName !== scene.name) { setLastSeenName(scene.name); setName(scene.name); }

  const patchScene = async (body: Record<string, string>) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${scene.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versionId ? { ...body, versionId } : body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
  };

  const saveIdentity = async () => {
    const n = number.trim(), nm = name.trim();
    if (n === scene.number && nm === scene.name) return;
    setSaving(true);
    try { await patchScene({ number: n, name: nm }); } finally { setSaving(false); }
  };

  const del = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${scene.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionId ? { versionId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "删除失败");
      router.push(`/production/${productionId}/scenes`);
    } finally { setDeleting(false); }
  };

  const isAct = scene.parentId === null;

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href={`/production/${productionId}/scenes`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回章节
          </Link>
          <div className="text-right">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">
              {isAct ? "Act" : "Scene"}
            </p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        {/* Identity: number + name */}
        <div className="rounded-2xl bg-white shadow-sm p-6 space-y-4 mb-4">
          <div className="flex gap-4">
            <div className="w-28 shrink-0 space-y-1.5">
              <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">编号</label>
              {canEdit ? (
                <input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  onBlur={saveIdentity}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  disabled={saving}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50"
                />
              ) : (
                <p className="text-sm text-zinc-700 py-2">{number || "—"}</p>
              )}
            </div>
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">名称</label>
              {canEdit ? (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={saveIdentity}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  disabled={saving}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:opacity-50"
                />
              ) : (
                <p className="text-sm text-zinc-700 py-2">{name || "—"}</p>
              )}
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div className="rounded-2xl bg-white shadow-sm p-6 space-y-5 mb-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">预期时长</label>
            <DurationInput
              value={parseDuration(scene.expectedDuration)}
              canEdit={canEdit}
              onSave={async (seconds) => {
                await patchScene({ 
                  expectedDuration: seconds != null ? seconds.toString() : "" 
                });
              }}
            />
          </div>
          <Field
            label="简介"
            value={scene.synopsis}
            multiline
            canEdit={canEdit}
            onSave={(v) => patchScene({ synopsis: v })}
          />
          <Field
            label="行动线"
            value={scene.actionLine}
            multiline
            canEdit={canEdit}
            onSave={(v) => patchScene({ actionLine: v })}
          />
          <Field
            label="音乐"
            value={scene.music}
            multiline
            canEdit={canEdit}
            onSave={(v) => patchScene({ music: v })}
          />
          <Field
            label="舞台呈现"
            value={scene.stageNotes}
            multiline
            canEdit={canEdit}
            onSave={(v) => patchScene({ stageNotes: v })}
          />
        </div>

        {/* Scene assets */}
        <div className="rounded-2xl bg-white shadow-sm px-6 py-4">
          <MountPointAssets
            productionId={productionId}
            mountType="scene"
            mountId={scene.id}
            label={`${scene.number}${scene.name ? ` ${scene.name}` : ""}`}
            canEdit={canEdit}
            versionId={versionId}
            display="panel"
          />
        </div>

        {/* Delete */}
        {canEdit && (
          <div className="rounded-2xl bg-white shadow-sm px-6 py-4">
            {confirmDelete ? (
              <div className="flex items-center gap-3">
                <p className="text-sm text-zinc-500 flex-1">
                  确认删除「{scene.number}{scene.name ? ` ${scene.name}` : ""}」？
                </p>
                <button
                  onClick={del}
                  disabled={deleting}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {deleting ? "删除中…" : "确认"}
                </button>
                <button onClick={() => setConfirmDelete(false)} className="text-sm text-zinc-400 hover:text-zinc-600">
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
  );
}
