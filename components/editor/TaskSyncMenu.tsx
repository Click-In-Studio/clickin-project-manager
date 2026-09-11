"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { BASE_PATH } from "@/lib/base-path";
import { datetimeLocalToIso } from "@/lib/tz";
import { findTaskItemContext, insertTaskLink, type TaskItemContext } from "@/lib/editor-task-sync";

type CreateOptions = {
  members: { userId: string; name: string }[];
  canCreateStandalone: boolean;
};

export default function TaskSyncMenu({ editor, productionId }: { editor: Editor | null; productionId: string }) {
  const [context, setContext] = useState<TaskItemContext | null>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CreateOptions | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [endTime, setEndTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const next = editor.state.selection.empty ? findTaskItemContext(editor) : null;
      setContext(previous => {
        if (previous?.pos !== next?.pos) setOpen(false);
        return next;
      });
    };
    refresh();
    editor.on("selectionUpdate", refresh);
    editor.on("update", refresh);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("update", refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!open || options) return;
    let alive = true;
    fetch(`${BASE_PATH}/api/production/${productionId}/tasks/create-options`)
      .then(async response => {
        const data = await response.json() as CreateOptions & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "加载负责人失败");
        if (alive) setOptions(data);
      })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "加载负责人失败"); });
    return () => { alive = false; };
  }, [open, options, productionId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [open]);

  const anchor = useMemo(() => {
    if (!editor || !context || editor.isDestroyed) return null;
    try { return editor.view.coordsAtPos(context.pos + 1); } catch { return null; }
  }, [editor, context]);

  if (!editor || !context || !anchor || typeof document === "undefined") return null;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 420));
  const top = Math.max(8, anchor.top - 42);
  const selectedAssignee = options?.members.find(member => member.userId === assigneeId) ?? null;

  async function createTask() {
    if (!context?.title || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: context.title,
          description: "由文档任务项同步创建。",
          assignees: selectedAssignee ? [{ userId: selectedAssignee.userId, name: selectedAssignee.name }] : [],
          startTime: null,
          endTime: endTime ? datetimeLocalToIso(endTime) : null,
          eventId: null,
        }),
      });
      const data = await response.json() as { task?: { id: string }; error?: string };
      if (!response.ok || !data.task) { setError(data.error ?? "同步失败"); return; }
      if (!insertTaskLink(editor!, context.pos, productionId, data.task.id)) {
        setError("任务已创建，但文档链接写入失败，请从任务页查看");
        return;
      }
      setOpen(false);
    } catch {
      setError("网络错误，同步失败");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div ref={panelRef} style={{ position: "fixed", left, top, zIndex: 9998 }}>
      <div className="flex max-w-[400px] items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-2 py-1 shadow-sm">
        <span className="max-w-[210px] truncate text-xs font-medium text-zinc-700">☑ {context.title || "未命名任务"}</span>
        {context.href ? (
          <a href={context.href} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100">
            打开任务 ↗
          </a>
        ) : (
          <button
            type="button"
            onMouseDown={event => event.preventDefault()}
            onClick={() => setOpen(value => !value)}
            className="shrink-0 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700"
          >
            同步任务
          </button>
        )}
      </div>
      {open && !context.href && (
        <div className="mt-1 w-[340px] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl">
          <p className="mb-3 text-sm font-semibold text-zinc-900">同步到任务</p>
          <label className="mb-3 block text-xs text-zinc-500">
            负责人
            <select value={assigneeId} onChange={event => setAssigneeId(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400">
              <option value="">暂不指派</option>
              {(options?.members ?? []).map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}
            </select>
          </label>
          <label className="mb-3 block text-xs text-zinc-500">
            截止时间
            <input type="datetime-local" value={endTime} onChange={event => setEndTime(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400" />
          </label>
          {options && !options.canCreateStandalone && <p className="mb-2 text-xs text-amber-700">当前权限不能创建独立任务，请到任务页选择关联事件。</p>}
          {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
          <button
            type="button"
            disabled={submitting || !options?.canCreateStandalone}
            onClick={() => void createTask()}
            className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "同步中…" : "创建并同步"}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
