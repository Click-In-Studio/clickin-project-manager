"use client";

import { useEffect, useRef, useState } from "react";
import BoundaryInsertMenu from "./BoundaryInsertMenu";

export default function RehearsalMarkInput({
  variant = "script-block",
  canAddChapterScene,
  canAddRehearsal,
  onAddChapterBefore,
  onAddSceneBefore,
  onAddRehearsalBefore,
  onConvertToChapter,
  onConvertToScene,
  onOpenSceneDetail,
}: {
  variant?: "script-block" | "marker-control";
  canAddChapterScene: boolean;
  canAddRehearsal: boolean;
  onAddChapterBefore: () => void;
  onAddSceneBefore: () => void;
  onAddRehearsalBefore: () => void;
  onConvertToChapter?: () => void;
  onConvertToScene?: () => void;
  onOpenSceneDetail?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const closeAfter = (fn: () => void) => {
    fn();
    setOpen(false);
  };
  const triggerLayoutClass = variant === "marker-control"
    ? "flex h-4 w-4 items-center justify-center p-0"
    : "px-0.5 py-0";
  const triggerTitle = canAddRehearsal
    ? "添加章节/段落/排练记号"
    : canAddChapterScene
      ? "添加章节/段落"
      : "标记操作";

  return (
    <span
      ref={wrapRef}
      className={`relative flex items-start gap-1 ${open ? "z-50" : ""}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        title={triggerTitle}
        data-rehearsal-triangle="true"
        className={`rounded ${triggerLayoutClass} text-[8px] font-bold leading-none tracking-wide text-zinc-300 transition-colors hover:text-zinc-500`}
      >
        ▶
      </button>
      {open && (
        <BoundaryInsertMenu
          canAddChapterScene={canAddChapterScene}
          canAddRehearsal={canAddRehearsal}
          onAddChapter={() => closeAfter(onAddChapterBefore)}
          onAddScene={() => closeAfter(onAddSceneBefore)}
          onAddRehearsal={() => closeAfter(onAddRehearsalBefore)}
          onConvertToChapter={onConvertToChapter ? () => closeAfter(onConvertToChapter) : undefined}
          onConvertToScene={onConvertToScene ? () => closeAfter(onConvertToScene) : undefined}
          onOpenSceneDetail={onOpenSceneDetail ? () => closeAfter(onOpenSceneDetail) : undefined}
        />
      )}
    </span>
  );
}
