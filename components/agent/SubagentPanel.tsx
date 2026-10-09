"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "@/components/ui/Markdown";
import ChevronIcon from "@/components/ui/ChevronIcon";
import type { SubagentView } from "@/lib/agent/runtime/subagent-types";

const STATUS: Record<string, string> = {
  queued: "排队中",
  running: "研读中",
  compacting: "整理上下文",
  awaiting_context: "等待补充资料",
  completed: "本轮完成",
  failed: "执行失败",
  aborted: "已停止",
  interrupted: "执行中断",
  stopped: "已停止",
};
type Trace = {
  view: SubagentView;
  entries: Array<{
    seq: number;
    payload: {
      type?: string;
      message?: {
        role?: string;
        toolName?: string;
        content?: Array<{ type: string; text?: string }>;
      };
    };
  }>;
  nextCursor: number;
  hasMore: boolean;
};

export default function SubagentPanel({
  sessionKey,
  onParentRun,
}: {
  sessionKey: string;
  onParentRun: () => void;
}) {
  const [children, setChildren] = useState<SubagentView[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const callback = useRef(onParentRun);
  callback.current = onParentRun;
  useEffect(() => {
    const events = new EventSource(
      `/api/agent/subagents/events?sessionKey=${encodeURIComponent(sessionKey)}`,
    );
    events.onmessage = (event) => {
      const data = JSON.parse(event.data) as {
        subagents: SubagentView[];
        parentStatus: string | null;
      };
      setChildren(data.subagents);
      if (data.parentStatus) callback.current();
    };
    return () => events.close();
  }, [sessionKey]);
  const read = async (id: string, cursor = 0) => {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(
        `/api/agent/subagents?sessionKey=${encodeURIComponent(sessionKey)}&subagentId=${encodeURIComponent(id)}&cursor=${cursor}`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取子助理结果");
      setTrace(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const stop = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch("/api/agent/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, subagentId: id }),
      });
      if (!response.ok)
        throw new Error((await response.json()).error || "无法停止子助理");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  if (!children.length) return null;
  const active = children.filter((r) =>
    ["queued", "running", "compacting", "awaiting_context"].includes(r.status),
  ).length;
  return (
    <section className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-subtle)] text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronIcon className={expanded ? "rotate-90" : ""} />
        <span>
          子助理 · {children.length} 个{active ? `，${active} 个待完成` : ""}
        </span>
      </button>
      {expanded && (
        <div className="max-h-64 space-y-2 overflow-y-auto px-4 pb-3">
          {children.map((child) => (
            <div
              key={child.id}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2"
            >
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-words">{child.task}</span>
                <span className="shrink-0 text-[var(--muted)]">
                  {STATUS[child.status] ?? child.status}
                </span>
              </div>
              {child.contextRequest && (
                <p className="mt-1 whitespace-pre-wrap break-words">
                  需要补充：{child.contextRequest}
                </p>
              )}
              {child.error && (
                <p className="mt-1 break-words text-[var(--danger)]">
                  {child.error}
                </p>
              )}
              {child.result && (
                <p className="mt-1 line-clamp-3 break-words text-[var(--muted)]">
                  {child.result}
                </p>
              )}
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  className="underline"
                  disabled={busy === child.id}
                  onClick={() => void read(child.id)}
                >
                  结果与阅读记录
                </button>
                {!["stopped", "aborted"].includes(child.status) && (
                  <button
                    type="button"
                    className="underline"
                    disabled={busy === child.id}
                    onClick={() => void stop(child.id)}
                  >
                    停止
                  </button>
                )}
              </div>
            </div>
          ))}
          {error && (
            <p role="alert" className="text-[var(--danger)]">
              {error}
            </p>
          )}
          {trace && (
            <div className="min-w-0 space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
              <div className="flex justify-between gap-2">
                <strong>结果与阅读记录</strong>
                <button type="button" onClick={() => setTrace(null)}>
                  关闭
                </button>
              </div>
              {trace.view.result && <Markdown content={trace.view.result} />}
              {trace.entries.map(({ seq, payload }) => {
                const message = payload.message;
                const text = message?.content
                  ?.filter((p) => p.type === "text")
                  .map((p) => p.text ?? "")
                  .join("\n");
                return text ? (
                  <div
                    key={seq}
                    className="min-w-0 border-t border-[var(--border)] pt-2"
                  >
                    <p className="mb-1 text-[var(--muted)]">
                      {message?.toolName ??
                        (message?.role === "assistant" ? "子助理" : "交接内容")}
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">
                      {text}
                    </pre>
                  </div>
                ) : null;
              })}
              {trace.hasMore && (
                <button
                  type="button"
                  className="underline"
                  disabled={!!busy}
                  onClick={() => void read(trace.view.id, trace.nextCursor)}
                >
                  下一段记录
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
