"use client";

// 文档任务项「同步任务」浮条（#670，交互方向承接 #379）。
//
// 光标停在 `- [ ]` 任务项上时，在这一行上方浮出一条：
//   · 未同步 → 「☑ 标题 ｜ 同步任务」→ 展开面板选负责人 / 截止时间 → 建任务并往这一行
//     写入 `[#](/__cm__/task/<id>)` 引用（lib/editor/editor-task-sync）；
//   · 已同步 → 「☑ 标题 · 状态 ｜ 打开任务 ↗」。
// 与 TextBubbleMenu 互让靠判据而不是靠 z-index：浮动条只在选区非空时出现，本条只在
// 选区折叠时出现，两者永不同框；`/` `@` `#` `[[` 补全菜单打开时本条让位（hidden）。
// 不能做的按钮**灰掉给原因**（UI 定式）：这一行没字、没有创建独立任务的权限。
// 权限判定端在 POST /tasks（canAccessNode task/*@create），这里只读 create-options
// 的同源开关配外壳。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { BASE_PATH } from "@/lib/base-path";
import { datetimeLocalToIso } from "@/lib/tz";
import { TASK_STATUS_LABELS, taskMentionLabel } from "@/lib/ops/task-types";
import { findTaskItemContext, insertTaskMention, taskBarLayout, type TaskItemContext } from "@/lib/editor/editor-task-sync";

type CreateOptions = {
  members: { userId: string; name: string }[];
  canCreateStandalone: boolean;
};

type LinkedTask =
  | { state: "loading" }
  | { state: "ok"; title: string; status: string }
  | { state: "forbidden" }
  | { state: "gone" };

const BAR_HEIGHT = 32;
const BAR_WIDTH = 380;

export default function TaskSyncMenu({ editor, productionId, hidden = false }: {
  editor: Editor | null;
  productionId: string;
  /** 补全菜单等更高优先级的弹层在场时让位 */
  hidden?: boolean;
}) {
  const [context, setContext] = useState<TaskItemContext | null>(null);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<{ left: number; top: number } | null>(null);
  const [options, setOptions] = useState<CreateOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [linked, setLinked] = useState<LinkedTask | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [endTime, setEndTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const linkedCache = useRef(new Map<string, LinkedTask>());

  // ① 触发：跟着选区走；换了一行就收起面板
  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const next = editor.isEditable ? findTaskItemContext(editor) : null;
      setContext(prev => {
        if (prev?.pos !== next?.pos) { setOpen(false); setError(null); }
        return next;
      });
    };
    const onFocus = () => setFocused(true);
    // 焦点进了本条（面板里的下拉 / 日期框）不算离开
    const onBlur = () => setTimeout(() => {
      if (barRef.current?.contains(document.activeElement)) return;
      setFocused(false);
    }, 0);
    refresh();
    setFocused(editor.isFocused);
    editor.on("selectionUpdate", refresh);
    editor.on("update", refresh);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("update", refresh);
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  // ② 定位：贴任务项 DOM；滚动 / 缩放跟着走（fixed 定位，视口坐标）
  const visible = !!editor && !!context && (focused || open) && !hidden;
  useEffect(() => {
    if (!visible || !editor || !context) { setLayout(null); return; }
    const place = () => {
      if (editor.isDestroyed) return;
      const dom = editor.view.nodeDOM(context.pos);
      if (!(dom instanceof HTMLElement)) { setLayout(null); return; }
      const rect = dom.getBoundingClientRect();
      const l = taskBarLayout(rect, { width: window.innerWidth, height: window.innerHeight },
        { barHeight: BAR_HEIGHT, barWidth: BAR_WIDTH });
      setLayout({ left: l.left, top: l.top });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [visible, editor, context]);

  // ③ 已同步行：取一次状态（同一任务缓存在本次编辑会话里）
  const taskId = context?.taskId ?? null;
  useEffect(() => {
    if (!visible || !taskId) { setLinked(null); return; }
    const cached = linkedCache.current.get(taskId);
    if (cached) { setLinked(cached); return; }
    let alive = true;
    setLinked({ state: "loading" });
    fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${taskId}`)
      .then(async res => {
        let next: LinkedTask;
        if (res.status === 403) next = { state: "forbidden" };
        else if (res.status === 404) next = { state: "gone" };
        else if (!res.ok) throw new Error(String(res.status));
        else {
          const data = await res.json() as { task: { title: string; status: string } };
          next = { state: "ok", title: data.task.title, status: data.task.status };
        }
        linkedCache.current.set(taskId, next);
        if (alive) setLinked(next);
      })
      .catch(() => { if (alive) setLinked(null); });
    return () => { alive = false; };
  }, [visible, taskId, productionId]);

  // ④ 未同步行：拉一次创建选项（外壳开关 canCreateStandalone 与人员池）
  useEffect(() => {
    if (!visible || taskId || options || optionsError) return;
    let alive = true;
    fetch(`${BASE_PATH}/api/production/${productionId}/tasks/create-options`)
      .then(async res => {
        const data = await res.json() as CreateOptions & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "加载创建选项失败");
        if (alive) setOptions({ members: data.members ?? [], canCreateStandalone: !!data.canCreateStandalone });
      })
      .catch(e => { if (alive) setOptionsError(e instanceof Error ? e.message : "加载创建选项失败"); });
    return () => { alive = false; };
  }, [visible, taskId, options, optionsError, productionId]);

  // 面板：点外面关
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [open]);

  if (!visible || !layout || typeof document === "undefined") return null;

  const title = context!.title;
  const noTitle = title.length === 0;
  const cannotCreate = options ? !options.canCreateStandalone : false;
  const disabledReason = noTitle
    ? "这一行还没有文字，先写下要做的事"
    : cannotCreate ? "你没有创建独立任务的权限（需要 task 创建权限），请到任务面板从事件里建"
      : optionsError ?? null;
  const selectedAssignee = options?.members.find(m => m.userId === assigneeId) ?? null;

  async function createTask() {
    if (!editor || !context || disabledReason || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks`, {
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
      const data = await res.json() as { task?: { id: string; title: string; status: string }; error?: string };
      if (!res.ok || !data.task) { setError(data.error ?? "同步失败"); return; }
      linkedCache.current.set(data.task.id, { state: "ok", title: data.task.title, status: data.task.status });
      if (!insertTaskMention(editor, context.pos, data.task.id, taskMentionLabel(data.task.title, data.task.status))) {
        setError("任务已创建，但没能写进这一行——请到任务面板查看");
        return;
      }
      setOpen(false);
      setAssigneeId("");
      setEndTime("");
    } catch {
      setError("网络错误，同步失败");
    } finally {
      setSubmitting(false);
    }
  }

  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return createPortal(
    <div ref={barRef} style={{ position: "fixed", left: layout.left, top: layout.top, zIndex: 9998 }} data-task-sync-bar>
      <div
        className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-2 shadow-sm"
        style={{ height: BAR_HEIGHT, maxWidth: BAR_WIDTH }}
        onMouseDown={keepFocus}
      >
        <span className="min-w-0 truncate text-xs font-medium text-zinc-700">
          ☑ {linked?.state === "ok" ? taskMentionLabel(linked.title, linked.status) : (title || "（空任务项）")}
        </span>
        {taskId ? (
          linked?.state === "forbidden" ? (
            <span className="shrink-0 text-xs text-zinc-400" title="这条任务对你不可见">无权查看</span>
          ) : linked?.state === "gone" ? (
            <span className="shrink-0 text-xs text-zinc-400">任务已删除</span>
          ) : (
            <a
              href={`${BASE_PATH}/production/${productionId}/tasks/${taskId}`}
              target="_blank" rel="noopener noreferrer"
              className="shrink-0 rounded px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100"
            >
              打开任务 ↗
            </a>
          )
        ) : (
          <button
            type="button"
            disabled={!!disabledReason}
            title={disabledReason ?? "建一条 production 任务，并把它挂到这一行"}
            onClick={() => setOpen(v => !v)}
            className="shrink-0 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            同步任务
          </button>
        )}
      </div>
      {open && !taskId && (
        <div className="mt-1 w-[340px] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl">
          <p className="mb-1 text-sm font-semibold text-zinc-900">同步到任务</p>
          <p className="mb-3 truncate text-xs text-zinc-500" title={title}>{title}</p>
          {options && options.members.length > 0 && (
            <label className="mb-3 block text-xs text-zinc-500">
              负责人
              <select
                value={assigneeId}
                onChange={e => setAssigneeId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400"
              >
                <option value="">暂不指派</option>
                {options.members.map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </select>
            </label>
          )}
          <label className="mb-3 block text-xs text-zinc-500">
            截止时间
            <input
              type="datetime-local"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400"
            />
          </label>
          {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
          <button
            type="button"
            disabled={submitting || !!disabledReason}
            title={disabledReason ?? undefined}
            onClick={() => void createTask()}
            className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "同步中…" : `创建任务（${TASK_STATUS_LABELS.pending}）`}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
