"use client";

import { useEffect, useRef, useState } from "react";

export default function BoundaryActionMenu({
  conversionLabel,
  onConvert,
  onDelete,
  deleting = false,
}: {
  conversionLabel: "转为章节" | "转为段落";
  onConvert: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const [openGroup, setOpenGroup] = useState<"convert" | "delete" | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openGroup === null || dismissing) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setDismissing(true);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [dismissing, openGroup]);

  const triggerClassName = "inline-flex h-5 items-center whitespace-nowrap text-xs text-zinc-300 transition-all hover:text-zinc-600";
  return (
    <div
      ref={rootRef}
      className={`inline-flex h-5 items-center gap-3 whitespace-nowrap transition-opacity ${dismissing ? "opacity-0" : openGroup === null ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}
      onTransitionEnd={(event) => {
        if (event.currentTarget !== event.target || !dismissing || event.propertyName !== "opacity") return;
        setOpenGroup(null);
        setDismissing(false);
      }}
    >
      {openGroup === null ? (
        <>
          <button type="button" onClick={(event) => { event.stopPropagation(); setOpenGroup("convert"); }} className={triggerClassName}>转换类型</button>
          {onDelete && <button type="button" onClick={(event) => { event.stopPropagation(); setOpenGroup("delete"); }} className={triggerClassName}>删除</button>}
        </>
      ) : openGroup === "delete" ? (
        <>
          <button type="button" disabled={deleting} onClick={(event) => { event.stopPropagation(); onDelete?.(); }} className="inline-flex h-5 items-center whitespace-nowrap text-xs text-red-500 hover:text-red-700 disabled:opacity-50">{deleting ? "删除中…" : "确认"}</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); setOpenGroup(null); }} className="inline-flex h-5 items-center whitespace-nowrap text-xs text-zinc-400 hover:text-zinc-600">取消</button>
        </>
      ) : (
        <>
          <button type="button" onClick={(event) => { event.stopPropagation(); setOpenGroup(null); onConvert(); }} className="inline-flex h-5 items-center whitespace-nowrap text-xs text-blue-600/80 transition-colors hover:text-blue-900/80">{conversionLabel}</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); setOpenGroup(null); }} className="inline-flex h-5 items-center whitespace-nowrap text-xs text-zinc-400 hover:text-zinc-600">取消</button>
        </>
      )}
    </div>
  );
}
