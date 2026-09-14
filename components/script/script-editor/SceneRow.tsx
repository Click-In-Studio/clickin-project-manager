"use client";

import { useState } from "react";
import type { Scene } from "@/lib/script/script-types";

export default function SceneRow({
  scene,
  onUpdate,
  onRemove,
  canRemove = true,
  indent = false,
}: {
  scene: Scene;
  onUpdate: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  canRemove?: boolean;
  indent?: boolean;
}) {
  const [name, setName] = useState(scene.name);
  const [lastSeenName, setLastSeenName] = useState(scene.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (lastSeenName !== scene.name) { setLastSeenName(scene.name); setName(scene.name); }

  const commit = () => {
    if (name.trim() !== scene.name) {
      onUpdate(scene.id, name.trim());
    }
  };

  return (
    <tr className="group border-b border-zinc-50 last:border-0">
      <td className={`py-1 pr-2 align-middle${indent ? " pl-4" : ""}`}>
        <span className={`block w-14 px-1 py-0.5 text-sm font-medium tabular-nums${indent ? " text-zinc-400" : " text-zinc-600"}`}>
          {scene.number || "—"}
        </span>
      </td>
      <td className="py-1 align-middle">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          className="w-full rounded border border-transparent px-1 py-0.5 text-sm outline-none focus:border-zinc-300"
          placeholder="名称"
        />
      </td>
      <td className="py-1 pl-2 align-middle">
        {!canRemove ? null : confirmDelete ? (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <button
              onClick={() => onRemove(scene.id)}
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
            className="text-zinc-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          >
            ×
          </button>
        )}
      </td>
    </tr>
  );
}
