"use client";

import React from "react";
import type { Cue } from "@/lib/ops/cue-types";
import InlineField from "./InlineField";
import { colorFor } from "./colors";
import type { CuePresence } from "./types";

export default function CueChip({
  cue, colorIdx, selected, warning, editable, presenceUsers, highlighted,
  onSelect, onCommitNumber, onCommitName, onDragStart,
}: {
  cue: Cue; colorIdx: number; selected: boolean; warning: boolean; editable: boolean;
  presenceUsers: CuePresence[];
  highlighted?: boolean;
  onSelect: () => void;
  onCommitNumber: (v: string) => void;
  onCommitName: (v: string) => void;
  onDragStart?: (e: React.MouseEvent) => void;
}) {
  const c = colorFor(colorIdx);
  return (
    <div
      data-chip-cue-id={cue.id}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); if (!selected) onSelect(); }}
      className={`flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-mono cursor-pointer transition-all select-none
        ${selected ? `${c.bg} text-white ring-2 ring-offset-1 ring-white/50 shadow` : `${c.light} ${c.text} whitespace-nowrap hover:ring-1 hover:ring-current/30`}
        ${warning ? "ring-1 ring-amber-400" : ""}
        ${highlighted && !selected ? "ring-2 ring-amber-400 ring-offset-1 shadow-sm shadow-amber-200" : ""}`}
      title={warning ? "⚠ 位置可能已偏移，请检查" : undefined}
    >
      {onDragStart && (
        <span
          onMouseDown={e => { e.stopPropagation(); onDragStart(e); }}
          className={`cursor-grab active:cursor-grabbing shrink-0 select-none leading-none
            ${selected ? "text-white/40 hover:text-white/70" : "text-current/25 hover:text-current/50"}`}
          style={{ fontSize: "9px", letterSpacing: "-1px" }}
        >⠿</span>
      )}
      {warning && <span className={selected ? "text-amber-200" : "text-amber-400"}>⚠</span>}
      {selected && editable ? (
        <>
          <InlineField
            value={cue.number}
            onCommit={onCommitNumber}
            placeholder="Q#"
            className="w-8 bg-white/20 text-white text-[10px] font-mono rounded px-0.5 outline-none placeholder:text-white/40 min-w-0"
          />
          <span className="text-white/40 shrink-0">/</span>
          <InlineField
            value={cue.name}
            onCommit={onCommitName}
            placeholder="名称"
            className="w-20 bg-white/20 text-white text-[10px] rounded px-0.5 outline-none placeholder:text-white/40 min-w-0"
          />
        </>
      ) : (
        <>
          <span className="font-bold">{cue.number}</span>
          {cue.name && <span className="opacity-70 max-w-[96px] truncate">{cue.name}</span>}
        </>
      )}
      {presenceUsers.length > 0 && (
        <div
          className="flex -space-x-1 ml-0.5 shrink-0"
          title={presenceUsers.map(p => p.userName).join("、")}
        >
          {presenceUsers.slice(0, 3).map(p => (
            <div
              key={p.clientId}
              style={{ backgroundColor: p.color, fontSize: "7px" }}
              className="h-3.5 w-3.5 rounded-full ring-1 ring-white/70 flex items-center justify-center font-bold text-white shrink-0"
            >
              {p.userName.charAt(0)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
