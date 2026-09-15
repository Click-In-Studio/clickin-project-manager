"use client";

import { useEffect, useRef, useState } from "react";
import type { Scene } from "@/lib/script/script-types";

export default function SceneHeader({
  scene,
  canEditName = false,
  onNameChange,
}: {
  scene: Scene;
  canEditName?: boolean;
  onNameChange?: (id: string, name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(scene.name);
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNameDraft(scene.name);
  }, [scene.id, scene.name]);
  useEffect(() => {
    if (!editingName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [editingName]);

  const commitName = () => {
    const nextName = nameDraft.trim();
    if (nextName !== scene.name) onNameChange?.(scene.id, nextName);
    setEditingName(false);
  };

  const startEditingName = () => {
    if (!canEditName) return;
    setNameDraft(scene.name);
    setEditingName(true);
  };

  const nameEl = (className: string, placeholder: string) => editingName ? (
    <input
      ref={nameInputRef}
      value={nameDraft}
      onChange={(e) => setNameDraft(e.target.value)}
      onBlur={commitName}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setNameDraft(scene.name);
          setEditingName(false);
        }
      }}
      placeholder={placeholder}
      className={`${className} min-w-[6rem] max-w-[18rem] rounded border border-transparent bg-transparent px-1 py-0.5 outline-none transition-colors placeholder:text-zinc-300 hover:border-zinc-200 hover:bg-white/70 focus:border-zinc-300 focus:bg-white`}
    />
  ) : (
    scene.name ? <span className={className}>{scene.name}</span> : null
  );

  if (scene.parentId === null) {
    return (
      <div className="flex select-none items-center gap-3 py-4">
        <div className="h-px flex-1 bg-zinc-300" />
        <div
          data-script-marker-title="true"
          className={`flex items-baseline gap-2.5${canEditName ? " cursor-text" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            startEditingName();
          }}
        >
          <span className="text-xs font-extrabold tracking-widest text-zinc-500">{scene.number}</span>
          {nameEl("text-base font-semibold text-zinc-600", "章节名称")}
        </div>
        <div className="h-px flex-1 bg-zinc-300" />
      </div>
    );
  }

  return (
    <div className="flex select-none items-center gap-2 py-2">
      <div className="h-px flex-1 bg-zinc-100" />
      <div
        data-script-marker-title="true"
        className={`flex items-baseline gap-1.5${canEditName ? " cursor-text" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          startEditingName();
        }}
      >
        <span className="text-[10px] font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {nameEl("text-xs text-zinc-400", "段落名称")}
      </div>
      <div className="h-px flex-1 bg-zinc-100" />
    </div>
  );
}
