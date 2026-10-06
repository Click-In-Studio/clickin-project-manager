"use client";

import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import type { DramaturgyWorkspaceMode } from "./use-dramaturgy-workspace-mode";

export default function DramaturgyModePicker({
  mode,
  canEdit,
  switching,
  error,
  onChange,
}: {
  mode: DramaturgyWorkspaceMode;
  canEdit: boolean;
  switching: boolean;
  error: string | null;
  onChange: (mode: DramaturgyWorkspaceMode) => void;
}) {
  return (
    <div className="relative shrink-0">
      <OverflowSafeSelect
        aria-label="页面模式"
        value={mode}
        disabled={switching}
        onChange={(event) => onChange(event.target.value as DramaturgyWorkspaceMode)}
        className="h-8 min-w-[88px] rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2.5 text-[11px] font-semibold text-[var(--ink)]"
      >
        <option value="read">只读</option>
        <option value="edit" disabled={!canEdit}>编辑</option>
      </OverflowSafeSelect>
      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 shadow-md"
        >
          {error}
        </p>
      )}
    </div>
  );
}
