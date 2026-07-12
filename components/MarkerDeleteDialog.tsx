"use client";

import type { MarkerDeleteOperation, MarkerDeletePlan } from "@/lib/script-marker-domain";

export type MarkerDeleteDialogState =
  | { plan: MarkerDeletePlan }
  | { plan: null; message?: string };

export default function MarkerDeleteDialog({
  state,
  busy = false,
  onChoose,
  onClose,
}: {
  state: MarkerDeleteDialogState;
  busy?: boolean;
  onChoose: (operation: MarkerDeleteOperation) => void;
  onClose: () => void;
}) {
  const plan = state.plan;
  const unavailable = plan === null;
  const blocked = plan?.status === "blocked";
  const choice = plan?.status === "choice";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-lg bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-base font-semibold text-zinc-800">
          {unavailable ? "没有可用的删除方式" : blocked ? `不可删除该${plan.kind === "chapter" ? "章节" : "段落"}` : "选择删除方式"}
        </h2>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-500">
          {unavailable
            ? state.message ?? "当前内容无法使用任何安全的删除方式。"
            : blocked
              ? plan.message
              : "该章节内的段落均为空段落。请选择是否保留其下属段落。"}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 disabled:opacity-50">
            {choice ? "取消" : "确认"}
          </button>
          {choice && plan.options.map((operation) => (
            <button
              key={operation.type}
              type="button"
              disabled={busy}
              onClick={() => onChoose(operation)}
              className={operation.type === "whole"
                ? "rounded border border-red-700/60 px-3 py-1.5 text-sm font-medium text-red-700/80 hover:border-red-700 hover:text-red-700 disabled:opacity-50"
                : "rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:border-zinc-300 hover:text-zinc-800 disabled:opacity-50"}
            >
              {operation.type === "whole" ? "删除全部内容" : "保留下属段落"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
