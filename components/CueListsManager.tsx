"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList, CueListTemplate } from "@/lib/cue-list-types";
import { TEMPLATE_ABBR_HINTS } from "@/lib/cue-list-types";

type Props = {
  productionId: string;
  initialCueLists: CueList[];
  canCreate: boolean;
  availableTemplates: CueListTemplate[];
  myUserId: string;
};

function CreateForm({
  productionId,
  availableTemplates,
  onCreated,
  onCancel,
}: {
  productionId: string;
  availableTemplates: CueListTemplate[];
  onCreated: (lists: CueList[]) => void;
  onCancel: () => void;
}) {
  const initTemplate = availableTemplates[0]?.key ?? "";
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(initTemplate);
  const [abbr, setAbbrState] = useState(TEMPLATE_ABBR_HINTS[initTemplate] ?? "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const prevTemplateRef = useRef(initTemplate);
  useEffect(() => {
    const prevHint = TEMPLATE_ABBR_HINTS[prevTemplateRef.current] ?? "";
    const newHint = TEMPLATE_ABBR_HINTS[template] ?? "";
    if (abbr === "" || abbr === prevHint) setAbbrState(newHint);
    prevTemplateRef.current = template;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  function handleAbbrChange(v: string) { setAbbrState(v.toUpperCase()); }
  function handleTemplateChange(key: string) { setTemplate(key); }

  const submit = async () => {
    if (!name.trim()) { setError("名称不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cuelists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          notes: notes.trim(),
          template: template || undefined,
          abbr: abbr.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        setError(j.error ?? "创建失败");
        return;
      }
      const lists = await res.json() as CueList[];
      onCreated(lists);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white shadow-sm p-4 space-y-3">
      <p className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">新建Cue表</p>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
          disabled={saving}
          autoFocus
          placeholder="Cue表名称"
          className="w-full rounded border border-zinc-200 px-2 py-1.5 text-xs outline-none focus:border-zinc-400 disabled:opacity-50"
        />
      </div>

      {availableTemplates.length > 0 && (
        <div className="space-y-1">
          <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">类型</label>
          <div className="flex flex-wrap gap-1">
            {availableTemplates.map((t) => (
              <button
                key={t.key}
                onClick={() => handleTemplateChange(t.key)}
                disabled={saving}
                className={`rounded px-2.5 py-1 text-xs transition-colors disabled:cursor-default ${
                  template === t.key
                    ? "bg-zinc-700 text-white"
                    : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                }`}
              >
                {t.label}
              </button>
            ))}
            <button
              onClick={() => handleTemplateChange("")}
              disabled={saving}
              className={`rounded px-2.5 py-1 text-xs transition-colors disabled:cursor-default ${
                template === ""
                  ? "bg-zinc-700 text-white"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              自定义
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
          简称 <span className="font-normal normal-case text-zinc-300">可选 · 同项目唯一</span>
        </label>
        <input
          value={abbr}
          onChange={(e) => handleAbbrChange(e.target.value)}
          disabled={saving}
          placeholder={template ? (TEMPLATE_ABBR_HINTS[template] ?? "如 XQ") : "如 XQ"}
          maxLength={8}
          className="w-full rounded border border-zinc-200 px-2 py-1.5 text-xs font-mono outline-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">备注</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={saving}
          rows={2}
          placeholder="—"
          className="w-full rounded border border-zinc-200 px-2 py-1.5 text-xs outline-none resize-none focus:border-zinc-400 disabled:opacity-50 placeholder:text-zinc-300"
        />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 disabled:opacity-50"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={saving}
          className="rounded bg-zinc-700 px-3 py-1.5 text-xs text-white hover:bg-zinc-900 disabled:opacity-50"
        >
          {saving ? "创建中…" : "创建"}
        </button>
      </div>
    </div>
  );
}

export default function CueListsManager({
  productionId,
  initialCueLists,
  canCreate,
  availableTemplates,
}: Props) {
  const [lists, setLists] = useState(initialCueLists);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex min-h-screen flex-col items-center bg-zinc-100 px-4 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <Link
            href={`/production/${productionId}/cues`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← Cue视图
          </Link>
          <h1 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">Cue表</h1>
        </div>

        {creating ? (
          <CreateForm
            productionId={productionId}
            availableTemplates={availableTemplates}
            onCreated={(newLists) => { setLists(newLists); setCreating(false); }}
            onCancel={() => setCreating(false)}
          />
        ) : canCreate ? (
          <button
            onClick={() => setCreating(true)}
            className="w-full rounded-2xl border-2 border-dashed border-zinc-200 py-4 text-xs text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors"
          >
            + 新建Cue表
          </button>
        ) : null}

        {lists.length === 0 ? (
          <div className="rounded-2xl bg-white shadow-sm p-8 text-center">
            <p className="text-sm text-zinc-400">暂无Cue表</p>
          </div>
        ) : (
          <div className="space-y-2">
            {lists.map((cl) => (
              <Link
                key={cl.id}
                href={`/production/${productionId}/cuelists/${cl.id}`}
                className="block rounded-2xl bg-white px-4 py-4 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-zinc-700 truncate">{cl.name}</p>
                      {cl.abbr && (
                        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-zinc-500">
                          {cl.abbr}
                        </span>
                      )}
                    </div>
                    {cl.template && (
                      <p className="text-[10px] text-zinc-400 mt-0.5">{cl.template}</p>
                    )}
                    {cl.notes && (
                      <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{cl.notes}</p>
                    )}
                  </div>
                  <p className="text-[10px] text-zinc-300 shrink-0 mt-0.5">{cl.createdByName}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
