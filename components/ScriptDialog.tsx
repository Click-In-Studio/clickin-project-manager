"use client";

import type { ReactNode } from "react";

const DEFAULT_SCRIPT_DIALOG_OVERLAY_CLASS = "fixed inset-0 z-50 flex items-center justify-center bg-black/40";

export const SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS = "rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700";
export const SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS = "rounded border border-transparent bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700";

export default function ScriptDialog({
  children,
  onClose,
  overlayClassName = DEFAULT_SCRIPT_DIALOG_OVERLAY_CLASS,
  panelClassName,
}: {
  children: ReactNode;
  onClose: () => void;
  overlayClassName?: string;
  panelClassName: string;
}) {
  return (
    <div
      className={overlayClassName}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className={panelClassName} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
