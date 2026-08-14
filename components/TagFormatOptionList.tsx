"use client";

import { useState } from "react";
import ChevronIcon from "@/components/ChevronIcon";

export type TagFormatOption = {
  id: string;
  label: string;
  color: string;
  sortOrder: number;
};

type Props = {
  options: TagFormatOption[];
  splitAfterOptionId: string | null;
  onSplitAfterOption?: (optionId: string) => void;
  optionColor?: (option: TagFormatOption) => string;
  defaultOptionId?: string | null;
  onColorChange?: (optionId: string, color: string) => void;
  onDefaultOption?: (optionId: string) => void;
  onDeleteOption?: (optionId: string) => void;
  onReorder?: (orderedOptions: TagFormatOption[]) => void;
};

export const TAG_FORMAT_GUIDE = "上下拖拽标签以调整顺序。如标签内容与文本格式相关（歌词格式/台词格式），在需要使用歌词格式的标签与需要使用文本格式的标签之间添加 “格式分界线”。";

export function TagFormatGuide() {
  return <p className="text-sm leading-6 text-gray-700">{TAG_FORMAT_GUIDE}</p>;
}

export default function TagFormatOptionList({
  options,
  splitAfterOptionId,
  onSplitAfterOption,
  optionColor = option => option.color,
  defaultOptionId,
  onColorChange,
  onDefaultOption,
  onDeleteOption,
  onReorder,
}: Props) {
  const [draggingOptionId, setDraggingOptionId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [editingColorId, setEditingColorId] = useState<string | null>(null);

  if (options.length === 0) return <p className="text-xs text-zinc-400">暂无选项</p>;

  const sorted = [...options].sort((a, b) => a.sortOrder - b.sortOrder);
  const splitIndex = splitAfterOptionId
    ? sorted.findIndex(option => option.id === splitAfterOptionId)
    : -1;
  const showOptionControls = Boolean(onColorChange || onDefaultOption || onDeleteOption);

  const finishDrag = () => {
    setDraggingOptionId(null);
    setDropIndex(null);
  };

  const dropAt = (targetIndex: number) => {
    if (!onReorder || !draggingOptionId) return finishDrag();
    const sourceIndex = sorted.findIndex(option => option.id === draggingOptionId);
    if (sourceIndex < 0) return finishDrag();
    const next = [...sorted];
    const [dragged] = next.splice(sourceIndex, 1);
    const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    next.splice(insertionIndex, 0, dragged);
    const reordered = next.map((option, index) => ({ ...option, sortOrder: index }));
    if (reordered.some((option, index) => option.id !== sorted[index]?.id)) onReorder(reordered);
    finishDrag();
  };

  return (
    <div onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null);
    }}>
      {sorted.map((option, index) => {
        const isActive = splitAfterOptionId === option.id;
        const isLyricSide = splitIndex >= 0 && index <= splitIndex;
        const displayColor = optionColor(option);
        return (
          <div
            key={option.id}
            className="relative"
            onDragOver={event => {
              if (!onReorder || !draggingOptionId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              setDropIndex(index + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0));
            }}
            onDrop={event => {
              event.preventDefault();
              dropAt(dropIndex ?? index);
            }}
          >
            {dropIndex === index && draggingOptionId !== option.id && (
              <div className="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 bg-[#91a8ca]" />
            )}
            <div className={`group/opt flex min-h-7 items-center gap-1.5 py-0.5 ${draggingOptionId === option.id ? "opacity-40" : ""}`}>
              {onReorder && (
                <span
                  draggable
                  role="button"
                  tabIndex={0}
                  aria-label={`拖拽调整 ${option.label} 的顺序`}
                  title="拖拽调整顺序"
                  onDragStart={event => {
                    setDraggingOptionId(option.id);
                    setDropIndex(index);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", option.id);
                  }}
                  onDragEnd={finishDrag}
                  className="shrink-0 cursor-grab select-none px-0.5 text-sm leading-none text-zinc-300 hover:text-zinc-500 active:cursor-grabbing"
                >
                  ⠿
                </span>
              )}
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-white ${isLyricSide ? "ring-2 ring-violet-900/30 ring-offset-1" : ""}`}
                style={{ backgroundColor: displayColor }}
              >
                {option.label}
              </span>
              {showOptionControls && (
                <div className={`${editingColorId === option.id ? "flex" : "hidden group-hover/opt:flex"} ml-0.5 items-center gap-0.5`}>
                  {onColorChange && (
                    <label
                      title="更改颜色"
                      className="relative inline-block h-3.5 w-3.5 shrink-0 cursor-pointer rounded-full border border-zinc-300"
                      style={{ backgroundColor: displayColor }}
                      onMouseDown={() => setEditingColorId(option.id)}
                    >
                      <input
                        type="color"
                        value={displayColor}
                        onChange={event => onColorChange(option.id, event.target.value)}
                        onBlur={() => setEditingColorId(null)}
                        className="absolute inset-0 h-full w-full cursor-pointer rounded-full opacity-0"
                      />
                    </label>
                  )}
                  {onDefaultOption && (
                    <button
                      type="button"
                      onClick={() => onDefaultOption(option.id)}
                      title={defaultOptionId === option.id ? "取消默认" : "设为默认"}
                      className={`rounded px-1 py-0.5 text-[10px] transition-colors ${
                        defaultOptionId === option.id
                          ? "bg-zinc-700 text-white"
                          : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                      }`}
                    >
                      {defaultOptionId === option.id ? "默认" : "设默认"}
                    </button>
                  )}
                  {onDeleteOption && (
                    <button
                      type="button"
                      onClick={() => onDeleteOption(option.id)}
                      title="删除"
                      aria-label={`删除 ${option.label}`}
                      className="px-0.5 text-zinc-300 transition-colors hover:text-red-400"
                    >
                      ×
                    </button>
                  )}
                </div>
              )}
            </div>
            {(onSplitAfterOption || isActive) && (
              <div
                onClick={onSplitAfterOption ? () => onSplitAfterOption(option.id) : undefined}
                className={`flex items-center gap-1.5 my-0.5 ${onSplitAfterOption ? "cursor-pointer group/slot" : ""}`}
              >
                {isActive ? (
                  <>
                    <div className="flex-1 border-t border-violet-300" />
                    <span className="inline-flex shrink-0 select-none items-center gap-0.5 rounded bg-violet-50 px-1.5 py-0.5 text-[9px] font-medium text-violet-500">
                      <span>♩ 歌词</span>
                      <ChevronIcon direction="up" size={9} />
                      <span aria-hidden="true" className="mx-1 h-2.5 border-l border-violet-200/60" />
                      <span>台词</span>
                      <ChevronIcon direction="down" size={9} />
                    </span>
                    <div className="flex-1 border-t border-violet-300" />
                  </>
                ) : (
                  <div className="flex w-full items-center gap-1.5 opacity-0 group-hover/slot:opacity-100 transition-opacity">
                    <div className="flex-1 border-t border-dashed border-zinc-200" />
                    <span className="shrink-0 text-[9px] text-zinc-300 select-none">格式分界线</span>
                    <div className="flex-1 border-t border-dashed border-zinc-200" />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {dropIndex === sorted.length && draggingOptionId !== sorted.at(-1)?.id && (
        <div
          className="h-0.5 bg-[#91a8ca]"
          onDragOver={event => event.preventDefault()}
          onDrop={event => {
            event.preventDefault();
            dropAt(sorted.length);
          }}
        />
      )}
    </div>
  );
}
