"use client";

import { useState } from "react";

export default function InlineField({
  value, onCommit, placeholder, className,
}: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  if (!focused && draft !== value) setDraft(value);
  return (
    <input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); if (draft !== value) onCommit(draft); }}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setDraft(value); e.currentTarget.blur(); }
      }}
      placeholder={placeholder}
      className={className}
    />
  );
}
