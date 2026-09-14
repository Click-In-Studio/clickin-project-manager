"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Block, Character, ScriptTextLayoutMode } from "@/lib/script/script-types";
import CharacterControlBottomSheet from "./CharacterControlBottomSheet";

export const FoldTriangle = ({ open }: { open: boolean }) => (
  <span
    aria-hidden
    className={`h-0 w-0 border-x-[3px] border-x-transparent ${
      open ? "border-b-[4px] border-b-current" : "border-t-[4px] border-t-current"
    }`}
  />
);

export default function BlockCharacterSelector({
  block,
  characters,
  onChange,
  onAnnotationChange,
  onForceShowCharacterNameChange,
  onEditingChange,
  editRequestToken,
  onArrowUp,
  onArrowDown,
  readOnly = false,
  layoutMode = "center",
  bottomGapClassName = "mb-2",
}: {
  block: Block;
  characters: Character[];
  onChange: (ids: string[]) => void;
  onAnnotationChange: (charId: string, annotation: string) => void;
  onForceShowCharacterNameChange: (force: boolean) => void;
  onEditingChange: (editing: boolean) => void;
  editRequestToken: number;
  onArrowUp: () => void;
  onArrowDown: () => void;
  readOnly?: boolean;
  layoutMode?: ScriptTextLayoutMode;
  bottomGapClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const setEditingWithNotify = useCallback((v: boolean) => { setEditing(v); onEditingChange(v); }, [onEditingChange]);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [mobileControlMenu, setMobileControlMenu] = useState<"display" | "annotations" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open editing when token increments (token changes on each external open request)
  const prevTokenRef = useRef(editRequestToken);
  useEffect(() => {
    if (editRequestToken > 0 && editRequestToken !== prevTokenRef.current) {
      prevTokenRef.current = editRequestToken;
      setEditingWithNotify(true);
    }
  }, [editRequestToken, setEditingWithNotify]);

  // Focus input whenever editing mode activates; auto-expand annotations if any exist
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      if (block.characterIds.some((id) => block.characterAnnotations[id])) setShowAnnotations(true);
    } else {
      setShowAnnotations(false);
      setDisplayMenuOpen(false);
      setMobileControlMenu(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setEditingWithNotify(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing, setEditingWithNotify]);

  const selected = characters.filter((c) => block.characterIds.includes(c.id));
  const suggestions = characters.filter(
    (c) => !block.characterIds.includes(c.id) && c.name.includes(query)
  );
  const selectorControlClass = "flex h-4 items-center gap-0.5 text-[11px] leading-none transition-colors";

  const addChar = (id: string) => {
    onChange([...block.characterIds, id]);
    setQuery("");
    setHighlightIdx(0);
    inputRef.current?.focus();
  };

  const removeChar = (id: string) =>
    onChange(block.characterIds.filter((c) => c !== id));

  const close = () => { setEditingWithNotify(false); setQuery(""); setHighlightIdx(0); setDisplayMenuOpen(false); };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (highlightIdx < suggestions.length - 1) {
        setHighlightIdx((i) => i + 1);
      } else {
        close();
        onArrowDown();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlightIdx > 0) {
        setHighlightIdx((i) => i - 1);
      } else {
        close();
        onArrowUp();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) {
        addChar(suggestions[Math.min(highlightIdx, suggestions.length - 1)].id);
        close();
        onArrowDown();
      }
    } else if (e.key === "Escape") {
      close();
    } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
      removeChar(selected[selected.length - 1].id);
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C") && query === "") {
      // Copy current character names as plain text
      e.preventDefault();
      const names = selected.map((c) => c.name).join("、");
      navigator.clipboard.writeText(names).catch(() => {});
    }
  };

  const charLabel = (c: Character) => {
    const ann = block.characterAnnotations[c.id];
    return ann ? `${c.name}（${ann}）` : c.name;
  };
  const compactLayout = layoutMode === "compact";

  if (!editing) {
    return (
      <div className={`${compactLayout ? "mb-0 flex justify-end text-right" : `${bottomGapClassName} flex translate-x-px justify-center`}`}>
        {readOnly ? (
          <span data-character-label="true" className={`max-w-full break-words text-sm font-bold leading-7 tracking-[0.12em] ${selected.length ? "text-zinc-800" : "text-zinc-300"}`}>
            {selected.length ? selected.map(charLabel).join("、") : "无角色"}
          </span>
        ) : (
          <button
            data-character-label="true"
            onClick={() => setEditingWithNotify(true)}
            className={`max-w-full break-words text-right text-sm font-bold leading-7 tracking-[0.12em] transition-colors ${
              selected.length
                ? "text-zinc-800 hover:text-zinc-500"
                : "text-zinc-300 hover:text-zinc-400"
            }`}
          >
            {selected.length ? selected.map(charLabel).join("、") : "无角色"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={`relative z-30 ${compactLayout ? "mb-0" : "mb-2"}`}>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 transition-colors focus-within:border-zinc-500">
        {selected.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
          >
            {c.name}
            <button
              onMouseDown={(e) => { e.preventDefault(); removeChar(c.id); }}
              className="ml-0.5 text-zinc-400 hover:text-zinc-700"
            >×</button>
          </span>
        ))}
        {characters.length === 0 ? (
          <p className="min-w-[12rem] flex-1 text-left text-xs leading-5 text-zinc-400">
            当前版本尚无任何角色。请通过【戏剧构作】—【角色】进行添加。
          </p>
        ) : (
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlightIdx(0); }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text/plain");
              const matches = text
                .split(/[、，,\n]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .flatMap((name) => {
                  const c = characters.find((c) => c.name === name && !block.characterIds.includes(c.id));
                  return c ? [c.id] : [];
                });
              if (matches.length > 0) {
                e.preventDefault();
                onChange([...block.characterIds, ...matches]);
              }
              // No matches → let default paste fill the search query
            }}
            placeholder={selected.length === 0 ? "搜索角色…" : ""}
            className="min-w-[5rem] flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-300"
          />
        )}
        {selected.length > 0 && !readOnly && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="relative flex h-4 items-center">
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (window.matchMedia("(max-width: 639px)").matches) {
                    setMobileControlMenu((current) => current === "display" ? null : "display");
                    return;
                  }
                  setDisplayMenuOpen((v) => !v);
                }}
                className={`${selectorControlClass} ${
                  block.forceShowCharacterName ? "text-zinc-600" : "text-zinc-300 hover:text-zinc-500"
                }`}
              >
                <span>显示状态</span>
                <span className="sm:hidden"><FoldTriangle open={mobileControlMenu === "display"} /></span>
                <span className="hidden sm:inline"><FoldTriangle open={displayMenuOpen} /></span>
              </button>
              {displayMenuOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 hidden w-32 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-xl sm:block">
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onForceShowCharacterNameChange(true);
                      setDisplayMenuOpen(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs ${
                      block.forceShowCharacterName ? "text-zinc-900" : "text-zinc-500 hover:bg-zinc-50"
                    }`}
                  >
                    永远显示该行角色
                  </button>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onForceShowCharacterNameChange(false);
                      setDisplayMenuOpen(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs ${
                      block.forceShowCharacterName ? "text-zinc-500 hover:bg-zinc-50" : "text-zinc-900"
                    }`}
                  >
                    自动
                  </button>
                </div>
              )}
            </div>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (window.matchMedia("(max-width: 639px)").matches) {
                  setMobileControlMenu((current) => current === "annotations" ? null : "annotations");
                  return;
                }
                setShowAnnotations((v) => !v);
              }}
              className={`${selectorControlClass} text-zinc-300 hover:text-zinc-500`}
            >
              <span>备注</span>
              <span className="sm:hidden"><FoldTriangle open={mobileControlMenu === "annotations"} /></span>
              <span className="hidden sm:inline"><FoldTriangle open={showAnnotations} /></span>
            </button>
          </div>
        )}
      </div>
      {showAnnotations && selected.length > 0 && (
        <div className="hidden flex-wrap gap-x-4 gap-y-0.5 rounded-b-lg border border-t-0 border-zinc-200 px-2.5 py-1.5 sm:flex">
          {selected.map((c) => (
            <label key={c.id} className="flex items-center gap-1">
              <span className="text-[11px] text-zinc-400">{c.name}</span>
              <input
                value={block.characterAnnotations[c.id] ?? ""}
                onChange={(e) => onAnnotationChange(c.id, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder="备注…"
                className="w-16 border-b border-zinc-200 bg-transparent text-[11px] text-zinc-600 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
              />
            </label>
          ))}
        </div>
      )}
      {mobileControlMenu === "display" && (
        <CharacterControlBottomSheet title="显示状态" onClose={() => setMobileControlMenu(null)}>
          <button
            type="button"
            onClick={() => {
              onForceShowCharacterNameChange(true);
              setMobileControlMenu(null);
            }}
            className={`flex w-full items-center justify-between border-t border-zinc-100 px-5 py-3.5 text-left text-[15px] ${
              block.forceShowCharacterName ? "font-medium text-zinc-900" : "text-zinc-600"
            }`}
          >
            <span>永远显示该行角色</span>
            {block.forceShowCharacterName && <span className="text-xs">✓</span>}
          </button>
          <button
            type="button"
            onClick={() => {
              onForceShowCharacterNameChange(false);
              setMobileControlMenu(null);
            }}
            className={`flex w-full items-center justify-between border-t border-zinc-100 px-5 py-3.5 text-left text-[15px] ${
              block.forceShowCharacterName ? "text-zinc-600" : "font-medium text-zinc-900"
            }`}
          >
            <span>自动</span>
            {!block.forceShowCharacterName && <span className="text-xs">✓</span>}
          </button>
        </CharacterControlBottomSheet>
      )}
      {mobileControlMenu === "annotations" && (
        <CharacterControlBottomSheet title="备注" onClose={() => setMobileControlMenu(null)}>
          <div className="border-t border-zinc-100 px-5 py-2">
            {selected.map((c) => (
              <label key={c.id} className="flex items-center gap-3 border-b border-zinc-100 py-3 last:border-0">
                <span className="w-20 shrink-0 truncate text-sm text-zinc-500">{c.name}</span>
                <input
                  value={block.characterAnnotations[c.id] ?? ""}
                  onChange={(e) => onAnnotationChange(c.id, e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  placeholder="备注…"
                  className="min-w-0 flex-1 border-b border-zinc-200 bg-transparent py-1 text-sm text-zinc-700 outline-none placeholder:text-zinc-300 focus:border-zinc-500"
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMobileControlMenu(null)}
            className="w-full border-t border-zinc-100 px-5 py-3.5 text-center text-[15px] font-medium text-zinc-700"
          >
            完成
          </button>
        </CharacterControlBottomSheet>
      )}
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-xl overflow-y-auto" style={{ maxHeight: "min(16rem, calc(100vh - 12rem))" }}>
          {suggestions.map((c, i) => (
            <button
              key={c.id}
              onMouseDown={(e) => { e.preventDefault(); addChar(c.id); }}
              className={`w-full px-4 py-1.5 text-left text-sm ${
                i === highlightIdx
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {suggestions.length === 0 && query && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2 shadow-xl">
          <p className="text-xs text-zinc-400">无匹配角色</p>
        </div>
      )}
    </div>
  );
}
