"use client";

import type { EventScheduleItemWithParticipants } from "@/lib/ops/event-db";
import { fmtTime } from "@/lib/tz";

export default function ScheduleItemPicker({
  items, selected, onChange,
}: {
  items: EventScheduleItemWithParticipants[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  function toggle(id: string) {
    onChange(selectedSet.has(id) ? selected.filter(x => x !== id) : [...selected, id]);
  }
  if (items.length === 0) return <p className="text-xs text-zinc-400">暂无流程项</p>;
  const sorted = [...items].sort((a, b) => {
    if (!a.startTime && !b.startTime) return 0;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });
  return (
    <div className="flex flex-col gap-1">
      {sorted.map(item => {
        const isSelected = selectedSet.has(item.id);
        return (
          <button key={item.id} onClick={() => toggle(item.id)}
            className={`text-left rounded-lg px-3 py-2 text-sm transition-colors ${
              isSelected ? "bg-zinc-800 text-white" : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
            }`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{item.title}</span>
              {isSelected && <span className="shrink-0 text-[10px] opacity-50">×</span>}
            </div>
            {item.startTime && (
              <p className={`text-[11px] mt-0.5 ${isSelected ? "text-zinc-300" : "text-zinc-400"}`}>
                {fmtTime(item.startTime)}{item.endTime ? ` — ${fmtTime(item.endTime)}` : ""}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
