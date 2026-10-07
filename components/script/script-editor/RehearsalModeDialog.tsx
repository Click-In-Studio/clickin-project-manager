"use client";

import ScriptDialog from "@/components/script/ScriptDialog";

export default function RehearsalModeDialog({ entering, pending, error, onClose, onConfirm }: {
  entering: boolean;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ScriptDialog onClose={onClose} panelClassName="w-[360px] rounded-2xl bg-white p-5 shadow-xl">
      <h2 className="text-base font-semibold text-zinc-800">
        {entering ? "确认进入排练模式？" : "确认退出排练模式？"}
      </h2>
      <p className="mt-2 text-sm leading-6 text-zinc-500">
        {entering
          ? "进入该模式后，将只能添加附件和评论，对剧本的其他编辑权限将被锁定。"
          : "退出后，将回到此前选择的编辑或只读模式。"}
      </p>
      {error && <p role="alert" className="mt-2 text-sm leading-5 text-red-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button disabled={pending} onClick={onClose} className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 disabled:cursor-wait disabled:text-zinc-300">
          取消
        </button>
        <button disabled={pending} onClick={onConfirm} className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:bg-zinc-400">
          {pending ? "保存中…" : "确认"}
        </button>
      </div>
    </ScriptDialog>
  );
}
