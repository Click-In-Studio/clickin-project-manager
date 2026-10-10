"use client";

import { useEffect, useRef, useState } from "react";

export default function InlineField({
  value, onCommit, onEditingChange, placeholder, className,
}: { value: string; onCommit: (v: string, basis: string) => void; onEditingChange?: (editing: boolean) => void; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const basisRef = useRef(value);
  const focusedRef = useRef(false);
  const editingChangeRef = useRef(onEditingChange);
  editingChangeRef.current = onEditingChange;
  useEffect(() => () => {
    if (focusedRef.current) editingChangeRef.current?.(false);
  }, []);
  if (!focused && draft !== value) setDraft(value);
  return (
    <input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => {
        basisRef.current = value;
        focusedRef.current = true;
        setFocused(true);
        onEditingChange?.(true);
      }}
      onBlur={() => {
        if (draft !== basisRef.current) onCommit(draft, basisRef.current);
        focusedRef.current = false;
        setFocused(false);
        onEditingChange?.(false);
      }}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          // Escape 放弃当前输入，不应由尚未更新的闭包把旧草稿保存出去。
          basisRef.current = draft;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      className={className}
    />
  );
}
