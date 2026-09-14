"use client";

import type { MemberWithRoles } from "@/lib/db";

export default function MemberCard({
  m, isSelected, onToggle,
}: { m: MemberWithRoles; isSelected: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      className={`text-left rounded-lg px-3 py-2 transition-colors ${
        isSelected ? "bg-zinc-800 text-white" : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
      }`}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-sm font-medium truncate">{m.name}</span>
        {isSelected && <span className="shrink-0 text-[10px] opacity-50">×</span>}
      </div>
      {m.roles.length > 0 && (
        <p className={`text-[11px] truncate mt-0.5 ${isSelected ? "text-zinc-300" : "text-zinc-400"}`}>
          {m.roles.join("、")}
        </p>
      )}
    </button>
  );
}
