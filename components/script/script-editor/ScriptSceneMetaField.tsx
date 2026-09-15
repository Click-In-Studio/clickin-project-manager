"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export default function ScriptSceneMetaField({
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
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useLayoutEffect(() => {
    if (!canEdit || !multiline) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const borderHeight = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
  }, [canEdit, draft, multiline]);

  const commit = async () => {
    if (draft === value) return;
    setSaving(true);
    try {
      await onSave(draft);
    } catch {
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="group space-y-1.5">
      <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">{label}</label>
      {canEdit ? (
        multiline ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={3}
            className="w-full resize-none overflow-hidden rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 hover:text-zinc-950 focus:border-zinc-400 disabled:opacity-50"
            placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving}
            className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 hover:text-zinc-950 focus:border-zinc-400 disabled:opacity-50"
            placeholder="—"
          />
        )
      ) : (
        <p className="min-h-[1.75rem] whitespace-pre-wrap rounded-lg border border-zinc-200 bg-transparent px-2.5 py-2 text-xs leading-relaxed text-zinc-700 transition-colors group-hover:border-zinc-300 group-hover:text-zinc-950">
          {value || <span className="italic text-zinc-400">—</span>}
        </p>
      )}
    </div>
  );
}
