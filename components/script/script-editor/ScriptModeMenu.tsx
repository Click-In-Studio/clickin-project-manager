"use client";

import React from "react";
import ChevronIcon from "@/components/ui/ChevronIcon";
import type { ScriptPersonalMode } from "./personal-mode";

export default function ScriptModeMenu({
  compact,
  open,
  currentLabel,
  selectedMode,
  canSelectEdit,
  pending,
  error,
  menuClassName,
  nestedMenuRef,
  nestedMenuStyle,
  onToggle,
  onSelect,
}: {
  compact: boolean;
  open: boolean;
  currentLabel: string;
  selectedMode: ScriptPersonalMode | null;
  canSelectEdit: boolean;
  pending: boolean;
  error: string;
  menuClassName: string;
  nestedMenuRef?: React.Ref<HTMLDivElement>;
  nestedMenuStyle?: React.CSSProperties;
  onToggle: () => void;
  onSelect: (mode: ScriptPersonalMode) => void;
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-script-toolbar-menu-trigger="mode"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${compact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
      >
        {currentLabel} <ChevronIcon size={12} className="opacity-50" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="剧本操作模式"
          data-script-toolbar-menu-panel="mode"
          data-production-overflow-menu-child={compact ? "true" : undefined}
          ref={compact ? nestedMenuRef : undefined}
          style={compact ? nestedMenuStyle : undefined}
          className={`${menuClassName} w-52`}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedMode === "edit"}
            disabled={!canSelectEdit || pending}
            onClick={() => onSelect("edit")}
            className={`flex w-full items-center justify-between px-3 py-2 text-sm ${canSelectEdit ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"}`}
            title={canSelectEdit ? "恢复本人可用的剧本编辑入口" : "当前账号没有剧本内容编辑权限"}
          >
            <span>编辑</span>
            {selectedMode === "edit" && <span aria-hidden="true">✓</span>}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedMode === "read"}
            disabled={pending}
            onClick={() => onSelect("read")}
            className="flex w-full items-center justify-between px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-300"
          >
            <span>只读</span>
            {selectedMode === "read" && <span aria-hidden="true">✓</span>}
          </button>
          {error && <p role="alert" className="border-t border-zinc-100 px-3 py-2 text-xs leading-5 text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
