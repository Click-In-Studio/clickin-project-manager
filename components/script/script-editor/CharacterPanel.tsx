"use client";

import React, { useState } from "react";
import Link from "next/link";
import ChevronIcon from "@/components/ui/ChevronIcon";
import type { Character } from "@/lib/script/script-types";
import CharacterRow from "./CharacterRow";
import { anchoredManagementPanelStyle } from "./constants";

export default function CharacterPanel({
  characters,
  productionId,
  focusedCharacterIds,
  onToggleFocus,
  onClearFocus,
  onAdd,
  onRemove,
  onRename,
  open,
  onOpenChange,
  onNavigate,
  readOnly = false,
  triggerClassName,
  nestedFromMore = false,
  nestedMenuRef,
  nestedMenuStyle,
  label = "角色",
}: {
  characters: Character[];
  productionId: string;
  focusedCharacterIds: Set<string>;
  onToggleFocus: (id: string) => void;
  onClearFocus: () => void;
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNavigate?: () => void;
  readOnly?: boolean;
  triggerClassName?: string;
  nestedFromMore?: boolean;
  nestedMenuRef?: React.RefObject<HTMLDivElement | null>;
  nestedMenuStyle?: React.CSSProperties;
  label?: string;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (readOnly) return;
    const name = draft.trim();
    if (!name) return;
    onAdd(name);
    setDraft("");
  };

  return (
    <div className="relative shrink-0">
      <button
        data-script-toolbar-menu-trigger="char"
        onClick={() => onOpenChange(!open)}
        className={triggerClassName ?? `flex items-center gap-0.5 rounded px-1.5 py-1 text-sm transition-colors ${
          open
            ? "bg-zinc-100 text-zinc-800"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
        }`}
      >
        {label} <ChevronIcon size={12} className="opacity-50" />
      </button>

      {open && (
        <div
          data-script-toolbar-menu-panel="char"
          data-production-overflow-menu-child={nestedFromMore ? "true" : undefined}
          ref={nestedFromMore ? nestedMenuRef : undefined}
          className={`${nestedFromMore ? "" : "absolute right-0 top-full mt-2.5"} z-40 flex w-56 flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-xl`}
          style={nestedFromMore ? anchoredManagementPanelStyle(nestedMenuStyle ?? {}) : { maxHeight: "min(28rem, calc(100vh - 8rem))" }}
        >
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-4 py-2">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">{readOnly ? "聚焦角色" : "角色管理"}</span>
            {(focusedCharacterIds.size > 0 || !readOnly) && (
              <div className="flex items-center gap-2">
                {focusedCharacterIds.size > 0 && (
                  <button
                    type="button"
                    onClick={onClearFocus}
                    className="whitespace-nowrap text-[11px] text-purple-800/60 transition-colors hover:text-purple-800"
                  >
                    重置聚焦
                  </button>
                )}
                {!readOnly && (
                  <Link href={`/production/${productionId}/characters`} onNavigate={onNavigate} className="whitespace-nowrap text-[11px] text-zinc-300 transition-colors hover:text-zinc-500">
                    管理页 →
                  </Link>
                )}
              </div>
            )}
          </div>

          <div className="overflow-y-auto">
          <table className="w-full">
            <tbody>
              {characters.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-300">暂无角色</td>
                </tr>
              ) : (
                characters.map((c) => (
                  <CharacterRow
                    key={c.id}
                    char={c}
                    focused={focusedCharacterIds.has(c.id)}
                    onToggleFocus={() => onToggleFocus(c.id)}
                    onRename={(name) => onRename(c.id, name)}
                    onRemove={() => onRemove(c.id)}
                    readOnly={readOnly}
                  />
                ))
              )}
            </tbody>
          </table>
          </div>

          {!readOnly && (
            <div className="shrink-0 flex items-center gap-2 border-t border-zinc-100 px-4 py-2.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="新角色名…"
                className="min-w-0 flex-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-300"
              />
              <button
                onClick={submit}
                disabled={!draft.trim()}
                className="shrink-0 rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-white hover:bg-zinc-600 disabled:opacity-30"
              >
                添加
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
