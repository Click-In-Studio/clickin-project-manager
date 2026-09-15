"use client";

import React from "react";

export default function CharacterControlBottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:hidden" onClick={onClose}>
      <div
        data-script-selection-action="true"
        className="max-h-[75vh] w-full overflow-y-auto rounded-t-2xl border-t border-[var(--line)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-zinc-200" />
        </div>
        <p className="px-5 py-2 text-xs font-medium text-zinc-400">{title}</p>
        {children}
        <div className="h-6" />
      </div>
    </div>
  );
}
