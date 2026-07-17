"use client";

import { useState, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";

export type MentionMember = { userId: string; name: string };

function computeDropStyle(ta: HTMLTextAreaElement): React.CSSProperties {
  const rect = ta.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  // prefer below; fall back above if not enough room
  if (spaceBelow >= 120 || spaceBelow >= spaceAbove) {
    return {
      position: "fixed",
      left: rect.left,
      width: rect.width,
      top: rect.bottom + 4,
      maxHeight: Math.min(220, spaceBelow - 8),
      overflowY: "auto",
      zIndex: 9999,
    };
  }
  return {
    position: "fixed",
    left: rect.left,
    width: rect.width,
    bottom: window.innerHeight - rect.top + 4,
    maxHeight: Math.min(220, spaceAbove - 8),
    overflowY: "auto",
    zIndex: 9999,
  };
}

export default function MentionTextarea({
  value, onChange, mentions, onMentionsChange, members,
  placeholder, rows, className, onKeyDown, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  mentions: MentionMember[];
  onMentionsChange: (m: MentionMember[]) => void;
  members: MentionMember[];
  placeholder?: string;
  rows?: number;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [drop, setDrop] = useState<{ active: boolean; atPos: number; filter: string; idx: number }>(
    { active: false, atPos: 0, filter: "", idx: 0 },
  );
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});

  const filtered = useMemo<MentionMember[]>(() => {
    if (!drop.active) return [];
    const f = drop.filter;
    if (!f) return members.slice(0, 6);
    return members.filter(m =>
      m.name.includes(f) || pinyinMatch(m.name, f.toLowerCase()) != null
    ).slice(0, 6);
  }, [drop.active, drop.filter, members]);

  const pickMember = useCallback((m: MentionMember) => {
    const ta = taRef.current; if (!ta) return;
    const before = value.slice(0, drop.atPos);
    const after = value.slice(drop.atPos + 1 + drop.filter.length);
    const next = `${before}@${m.name} ${after}`;
    onChange(next);
    onMentionsChange([...mentions.filter(x => x.userId !== m.userId), m]);
    setDrop(d => ({ ...d, active: false }));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = before.length + 1 + m.name.length + 1;
      ta.setSelectionRange(pos, pos);
    });
  }, [value, drop, onChange, onMentionsChange, mentions]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cur = e.target.selectionStart ?? val.length;
    onChange(val);
    const match = val.slice(0, cur).match(/@([^\s@]*)$/);
    if (match) {
      setDropStyle(computeDropStyle(e.target));
      setDrop({ active: true, atPos: cur - match[0].length, filter: match[1], idx: 0 });
    } else {
      setDrop(d => d.active ? { ...d, active: false } : d);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (drop.active && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setDrop(d => ({ ...d, idx: Math.min(d.idx + 1, filtered.length - 1) }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setDrop(d => ({ ...d, idx: Math.max(d.idx - 1, 0) }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMember(filtered[drop.idx]);
        return;
      }
      if (e.key === "Escape") {
        setDrop(d => ({ ...d, active: false }));
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <>
      <textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setDrop(d => ({ ...d, active: false })), 150)}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={className}
      />
      {drop.active && filtered.length > 0 && typeof document !== "undefined" && createPortal(
        <div style={dropStyle}
          className="bg-white rounded-xl shadow-lg border border-zinc-100 py-1">
          {filtered.map((m, i) => (
            <button
              key={m.userId}
              onMouseDown={e => { e.preventDefault(); pickMember(m); }}
              className={`w-full text-left px-3 py-2 text-sm ${
                i === drop.idx ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
