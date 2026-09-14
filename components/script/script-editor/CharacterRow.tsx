"use client";

import { useState } from "react";
import ModeSwitch from "@/components/script/ModeSwitch";
import type { Character } from "@/lib/script/script-types";

export default function CharacterRow({
  char,
  focused,
  onToggleFocus,
  onRename,
  onRemove,
  readOnly = false,
}: {
  char: Character;
  focused: boolean;
  onToggleFocus: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(char.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const commit = () => {
    const t = draft.trim();
    if (t) onRename(t);
    else setDraft(char.name);
    setEditing(false);
  };

  return (
    <tr className="group border-b border-zinc-50 last:border-0">
      <td className="max-w-0 px-4 py-2 w-full">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(char.name); setEditing(false); }
            }}
            className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none"
          />
        ) : (
          <span
            onClick={() => {
              if (readOnly) return;
              setDraft(char.name);
              setEditing(true);
            }}
            className={`block truncate whitespace-nowrap text-sm text-zinc-700 ${readOnly ? "" : "cursor-text hover:text-zinc-900"}`}
            title={readOnly ? undefined : "点击重命名"}
          >
            {char.name}
          </span>
        )}
      </td>
      <td className="w-8 py-2 pr-2 text-right align-middle">
        <button
          type="button"
          onClick={onToggleFocus}
          className="inline-flex items-center align-middle"
          title={focused ? "取消聚焦角色" : "聚焦角色"}
          aria-pressed={focused}
        >
          <ModeSwitch active={focused} activeClassName="bg-purple-800/60" />
        </button>
      </td>
      {!readOnly && (
        <td className="w-7 py-2 pr-4 text-right align-middle whitespace-nowrap">
          {confirmDelete ? (
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <button
                onClick={onRemove}
                className="text-xs text-red-500 hover:text-red-700"
              >
                确认
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-sm text-zinc-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              ×
            </button>
          )}
        </td>
      )}
    </tr>
  );
}
