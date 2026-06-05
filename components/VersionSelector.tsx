"use client";

import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Version, VersionStatus } from "@/lib/db";

const STATUS_LABELS: Record<VersionStatus, string> = {
  editing: "编辑中",
  committed: "已提交",
  frozen: "已冻结",
  archived: "已归档",
};

const STATUS_COLORS: Record<VersionStatus, string> = {
  editing: "bg-emerald-100 text-emerald-700",
  committed: "bg-amber-100 text-amber-700",
  frozen: "bg-blue-100 text-blue-700",
  archived: "bg-zinc-100 text-zinc-500",
};

interface Props {
  productionId: string;
  versions: Version[];
  currentVersionId: string | null;
  canManage?: boolean;
  onChange: (versionId: string) => void;
  onNavigate?: () => void;
}

export default function VersionSelector({
  productionId, versions, currentVersionId, canManage, onChange, onNavigate,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const urlHandled = useRef(false);
  const searchParams = useSearchParams();

  const current = versions.find(v => v.id === currentVersionId)
    ?? versions.find(v => v.status === "editing")
    ?? versions[0];

  // On first mount, apply ?v= URL param if it names a valid version different from current
  useEffect(() => {
    if (urlHandled.current) return;
    urlHandled.current = true;
    const vParam = searchParams.get("v");
    if (!vParam || vParam === currentVersionId) return;
    if (versions.some(v => v.id === vParam)) select(vParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const select = (versionId: string) => {
    document.cookie = `ver_${productionId}=${encodeURIComponent(versionId)}; path=/; max-age=31536000; SameSite=Lax`;
    setOpen(false);
    onChange(versionId);
  };

  if (!versions.length) return null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg px-1.5 py-1 text-sm text-zinc-600 hover:bg-zinc-100 transition-colors"
      >
        <span className="inline-block max-w-[116px] truncate align-bottom font-medium">{current?.name ?? "选择版本"}</span>
        {current && (
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${STATUS_COLORS[current.status]}`}>
            {STATUS_LABELS[current.status]}
          </span>
        )}
        <svg className="h-3 w-3 shrink-0 opacity-40" viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="fixed left-2 top-14 z-50 mt-1 min-w-[220px] rounded-xl border border-zinc-200 bg-white py-1 shadow-lg md:absolute md:left-0 md:top-full">
          {versions.map(v => (
            <button
              key={v.id}
              onClick={() => select(v.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-50 transition-colors ${v.id === current?.id ? "bg-zinc-50" : ""}`}
            >
              <span className="flex-1 font-medium text-zinc-800 truncate">{v.name}</span>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${STATUS_COLORS[v.status]}`}>
                {STATUS_LABELS[v.status]}
              </span>
            </button>
          ))}
          {canManage && (
            <>
              <div className="mx-3 my-1 border-t border-zinc-100" />
              <Link
                href={`/production/${productionId}/versions`}
                onClick={() => setOpen(false)}
                onNavigate={onNavigate}
                className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 transition-colors"
              >
                管理版本…
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
