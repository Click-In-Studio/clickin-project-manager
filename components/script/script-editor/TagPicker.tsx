"use client";

import { useEffect, useRef } from "react";
import type { TagGroup, BlockTagValue } from "@/lib/script/script-block-tag-db";

export default function TagPicker({
  tagGroups,
  blockTagValues,
  onTagChange,
  onCopy,
  onPaste,
  onClose,
}: {
  tagGroups: TagGroup[];
  blockTagValues: BlockTagValue[];
  onTagChange: (groupId: string, optionId: string | null, value: number | null, del: boolean) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 bottom-full z-50 mb-1 w-52 rounded-xl border border-zinc-200 bg-white p-2.5 shadow-lg"
      onMouseDown={e => e.stopPropagation()}
    >
      {tagGroups.map(group => {
        const tagVal = blockTagValues.find(t => t.groupId === group.id);
        return (
          <div key={group.id} className="mb-2.5 last:mb-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{group.name}</p>
            {group.type === "exclusive" ? (
              <div className="flex flex-wrap gap-1">
                {group.options.map(opt => {
                  const selected = tagVal?.optionId === opt.id;
                  const isDefault = !tagVal?.optionId && opt.id === group.defaultOptionId;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => selected
                        ? onTagChange(group.id, null, null, true)
                        : onTagChange(group.id, opt.id, null, false)
                      }
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium transition-all"
                      style={{
                        backgroundColor: (selected || isDefault) ? opt.color + "22" : "#f4f4f5",
                        color: (selected || isDefault) ? opt.color : "#a1a1aa",
                        outline: selected ? `1.5px solid ${opt.color}` : "none",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={group.rangeMin ?? 0}
                  max={group.rangeMax ?? 10}
                  step={group.rangeStep ?? 1}
                  value={tagVal?.value ?? group.rangeDefault ?? group.rangeMin ?? 0}
                  onChange={e => onTagChange(group.id, null, Number(e.target.value), false)}
                  className="flex-1 h-1 accent-zinc-600"
                />
                <span className="w-6 text-right text-[10px] text-zinc-500">
                  {tagVal?.value ?? group.rangeDefault ?? group.rangeMin ?? 0}
                </span>
              </div>
            )}
          </div>
        );
      })}
      <div className="mt-2 flex items-center justify-end gap-3 border-t border-zinc-100 pt-2">
        <button onClick={() => { onCopy(); onClose(); }} className="text-[10px] text-zinc-400 hover:text-zinc-600">复制标签</button>
        <button onClick={() => { onPaste(); onClose(); }} className="text-[10px] text-zinc-400 hover:text-zinc-600">粘贴标签</button>
      </div>
    </div>
  );
}
