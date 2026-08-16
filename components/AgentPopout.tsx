"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-gateway/stream-reducer";
import { parseSessionIdentity } from "@/lib/mcp/session-identity";

type SessionSummary = {
  key: string;
  title: string;
  lastMessagePreview?: string;
  updatedAt?: number;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
};

type GatewayStatus =
  | { state: "unconfigured" }
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "pairing_required"; requestId?: string }
  | { state: "error"; error: string };

// AI 助手浮动 popout——退休 /agent 独立页面（components/AgentChatClient 原逻辑
// 迁移至此，改为 AppShell 内挂载）。会话范围由所在语境决定，不再有「个人/关联
// 制作」选择器：项目视图内只列该项目会话、项目视图外只列个人会话，新建对话
// 直接落在当前语境。始终挂载（用 CSS 隐藏而非卸载），使后台流式回复在收起
// popout 时也不中断——sessions 列表里 running 状态可佐证仍在跑。
export default function AgentPopout({
  open,
  onClose,
  productionId,
  productionName,
}: {
  open: boolean;
  onClose: () => void;
  productionId: string | null;
  productionName: string | null;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;

  const inScope = useCallback(
    (key: string) => {
      // parseSessionIdentity 的正则不锚定开头，自带兼容 gateway 回显的
      // agent:<agentId>: 前缀，无需在这里再剥一层。
      const keyProductionId = parseSessionIdentity(key)?.productionId ?? null;
      return productionId ? keyProductionId === productionId : keyProductionId === null;
    },
    [productionId],
  );
  const scopedSessions = sessions.filter((s) => inScope(s.key));

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[]; gatewayStatus?: GatewayStatus };
      setSessions(data.sessions);
      if (data.gatewayStatus) setGatewayStatus(data.gatewayStatus);
    } catch {
      // network hiccup — 列表原地保留旧值
    }
  }, []);

  // 打开时拉一次；popout 不常开，没必要挂载即请求（会摊到每个页面）。
  useEffect(() => {
    if (open) refreshSessions();
  }, [open, refreshSessions]);

  // 语境切换（跨制作导航、进出项目视图）后，当前会话若不再属于新范围就摘掉——
  // 后台仍在跑，只是不该继续显示在这个范围的窗口里。
  useEffect(() => {
    if (activeKey && !inScope(activeKey)) {
      setActiveKey(null);
      setBubbles([]);
    }
  }, [productionId, activeKey, inScope]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-ai-toggle]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, streaming]);

  // 读一条 NDJSON/SSE 聊天流进气泡列表——"发送" 和 "接回运行中会话" 共用。
  const consumeStream = useCallback(async (res: Response, forKey: string) => {
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `请求失败（${res.status}）` }));
      setBubbles((prev) => [...prev, { kind: "notice", text: (err as { error?: string }).error || "请求失败" }]);
      return;
    }
    setStreaming(true);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let lastByteAt = Date.now();
    let watchdogFired = false;
    const watchdog = setInterval(() => {
      if (!watchdogFired && Date.now() - lastByteAt > 60_000) {
        watchdogFired = true;
        reader.cancel().catch(() => {});
      }
    }, 5_000);

    let streamKey = forKey;

    const apply = (line: StreamLine) => {
      if (activeKeyRef.current !== streamKey) return;
      setBubbles((prev) => applyStreamLine(prev, line));
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const line = JSON.parse(payload) as StreamLine;
            if (line.type === "ping") continue;
            if (line.type === "session") {
              if (typeof line.key === "string" && line.key && activeKeyRef.current === streamKey) {
                streamKey = line.key;
                activeKeyRef.current = line.key;
                setActiveKey(line.key);
              }
              continue;
            }
            apply(line);
          } catch {
            // skip malformed line
          }
        }
      }
    } finally {
      clearInterval(watchdog);
      setStreaming(false);
      setBubbles((prev) =>
        prev.map((b) => (b.kind === "assistant" && b.streaming ? { kind: "assistant", text: b.text } : b))
      );
      refreshSessions();
    }
  }, [refreshSessions]);

  const openSession = useCallback(async (key: string, status?: SessionSummary["status"]) => {
    setPickerOpen(false);
    setActiveKey(key);
    setBubbles([]);
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/agent/chat/history?sessionKey=${encodeURIComponent(key)}`);
      if (res.ok) {
        const data = (await res.json()) as {
          messages: ({ role: "user" | "assistant"; content: string } | { role: "tool"; name: string; id?: string })[];
        };
        if (activeKeyRef.current !== key) return;
        setBubbles(
          data.messages.map((m) =>
            m.role === "tool"
              ? { kind: "tool", name: m.name, id: m.id, done: true }
              : { kind: m.role, text: m.content }
          )
        );
      }
    } finally {
      if (activeKeyRef.current === key) setLoadingHistory(false);
    }
    if (status === "running") {
      const res = await fetch(`/api/agent/chat/stream?sessionKey=${encodeURIComponent(key)}`);
      consumeStream(res, key);
    }
  }, [consumeStream]);

  const newSession = useCallback(async () => {
    setPickerOpen(false);
    const res = await fetch("/api/agent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(productionId ? { productionId } : {}),
    });
    if (!res.ok) return;
    const { key } = (await res.json()) as { key: string };
    setActiveKey(key);
    setBubbles([]);
  }, [productionId]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message) return;
    let key = activeKey;
    if (!key) {
      const res = await fetch("/api/agent/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(productionId ? { productionId } : {}),
      });
      if (!res.ok) return;
      ({ key } = (await res.json()) as { key: string });
      setActiveKey(key);
    }
    setInput("");
    setBubbles((prev) => [...prev, { kind: "user", text: message }]);

    const res = await fetch("/api/agent/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: key, message, steer: streaming || undefined }),
    });
    if (streaming) {
      const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !out?.ok) {
        setBubbles((prev) => [...prev, { kind: "notice", text: out?.error || "消息注入失败，请等本轮结束后重发" }]);
      }
    } else {
      consumeStream(res, key);
    }
  }, [input, activeKey, streaming, consumeStream, productionId]);

  const abort = useCallback(async () => {
    if (!activeKey) return;
    await fetch("/api/agent/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: activeKey }),
    }).catch(() => {});
  }, [activeKey]);

  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const decideApproval = useCallback(async (approvalId: string, decision: string, reason?: string) => {
    setDenyingId(null);
    setDenyReason("");
    setBubbles((prev) =>
      prev.map((b) => (b.kind === "approval" && b.approval.id === approvalId ? { ...b, resolving: true } : b))
    );
    const res = await fetch("/api/agent/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approvalId, decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
    }).catch(() => null);
    if (!res?.ok) {
      const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setBubbles((prev) =>
        prev.map((b) => (b.kind === "approval" && b.approval.id === approvalId ? { ...b, resolving: false } : b))
      );
      setBubbles((prev) => [...prev, { kind: "notice", text: err.error || "确认请求处理失败" }]);
    }
  }, []);

  const removeSession = useCallback(async (key: string) => {
    if (!confirm("删除这个对话？")) return;
    await fetch(`/api/agent/sessions/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (activeKeyRef.current === key) {
      setActiveKey(null);
      setBubbles([]);
    }
    refreshSessions();
  }, [refreshSessions]);

  const renameSession = useCallback(async (key: string, current: string) => {
    const title = prompt("重命名对话", current)?.trim();
    if (!title) return;
    await fetch(`/api/agent/sessions/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    refreshSessions();
  }, [refreshSessions]);

  const activeSession = scopedSessions.find((s) => s.key === activeKey) ?? null;
  const scopeLabel = productionId ? productionName ?? "本项目" : "个人";

  const statusBanner = (() => {
    if (!gatewayStatus || gatewayStatus.state === "connected") return null;
    const text =
      gatewayStatus.state === "unconfigured"
        ? "AI 网关未配置"
        : gatewayStatus.state === "pairing_required"
          ? "AI 网关等待配对确认"
          : gatewayStatus.state === "error"
            ? `AI 网关连接失败：${gatewayStatus.error}`
            : "AI 网关未连接";
    return (
      <div className="mx-3 mt-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-xs text-[var(--warn)]">
        {text}
      </div>
    );
  })();

  return (
    <div
      ref={panelRef}
      aria-hidden={!open}
      className={`fixed right-0 top-16 bottom-0 z-40 hidden w-[440px] max-w-[92vw] flex-col border-l border-[var(--line)] bg-[var(--surface)] shadow-[-18px_0_55px_rgba(24,42,42,.18)] transition-transform duration-200 ease-out lg:flex ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
    >
      {/* 会话选择——放在 popout 最顶上 */}
      <div className="relative shrink-0 border-b border-[var(--line)] p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-left hover:border-[var(--ink)]"
          >
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">{scopeLabel}</span>
              <span className="truncate text-[12px] font-semibold text-[var(--ink)]">
                {activeSession ? activeSession.title : "新对话"}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-[var(--muted)]">{pickerOpen ? "▲" : "▼"}</span>
          </button>
          <button
            type="button"
            onClick={() => newSession()}
            title="新对话"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--surface)] text-sm text-[var(--muted)] hover:bg-[var(--paper)]"
          >
            +
          </button>
          <button
            type="button"
            onClick={onClose}
            title="收起"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm text-[var(--muted)] hover:bg-[var(--paper)]"
          >
            ✕
          </button>
        </div>

        {pickerOpen && (
          <div className="absolute left-3 right-3 top-full z-10 mt-1.5 max-h-80 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] py-1 shadow-[0_18px_55px_rgba(24,42,42,.18)]">
            {scopedSessions.length === 0 && (
              <p className="px-3 py-3 text-center text-[11px] text-[var(--muted)]">
                {productionId ? "该项目还没有对话" : "还没有个人对话"}
              </p>
            )}
            {scopedSessions.map((s) => (
              <div
                key={s.key}
                className={`group flex cursor-pointer items-center gap-1 px-2 py-1.5 text-[12px] ${
                  s.key === activeKey ? "bg-[var(--paper)]" : "hover:bg-[var(--paper)]"
                }`}
                onClick={() => openSession(s.key, s.status)}
              >
                {s.status === "running" && (
                  <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{s.title}</span>
                <span className="hidden shrink-0 gap-1 group-hover:flex">
                  <button
                    onClick={(e) => { e.stopPropagation(); renameSession(s.key, s.title); }}
                    className="text-[var(--muted)] hover:text-[var(--ink)]"
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeSession(s.key); }}
                    className="text-[var(--muted)] hover:text-[var(--danger)]"
                    title="删除"
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {statusBanner}

      {/* 聊天区 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {loadingHistory && <p className="text-center text-sm text-zinc-400">加载中…</p>}
        {!loadingHistory && bubbles.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-sm text-zinc-400">
              {productionId ? `向 AI 助手提问关于《${scopeLabel}》的问题` : "向 AI 助手提问吧"}
            </p>
          </div>
        )}
        {bubbles.map((b, i) => {
          if (b.kind === "user") {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-zinc-900 px-3.5 py-2 text-sm text-white">
                  {b.text}
                </div>
              </div>
            );
          }
          if (b.kind === "assistant") {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-zinc-100 px-3.5 py-2 text-sm">
                  <Markdown content={b.text} size="sm" />
                  {b.streaming && <span className="inline-block h-3 w-1.5 animate-pulse bg-zinc-400" />}
                </div>
              </div>
            );
          }
          if (b.kind === "tool") {
            return (
              <div key={i} className="flex justify-start">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-500">
                  {b.done ? "✓" : <span className="inline-block h-2 w-2 animate-spin rounded-full border border-zinc-400 border-t-transparent" />}
                  {b.name}
                </span>
              </div>
            );
          }
          if (b.kind === "approval") {
            const severityStyle =
              b.approval.severity === "critical"
                ? "border-red-300 bg-red-50"
                : b.approval.severity === "info"
                  ? "border-sky-200 bg-sky-50"
                  : "border-amber-300 bg-amber-50";
            const decisionLabel: Record<string, string> = {
              "allow-once": "允许一次",
              "allow-always": "始终允许",
              deny: "拒绝",
            };
            return (
              <div key={i} className="flex justify-start">
                <div className={`max-w-[92%] rounded-xl border px-3.5 py-3 text-sm ${severityStyle}`}>
                  <p className="font-medium text-zinc-800">⚠ 需要确认：{b.approval.title}</p>
                  {b.approval.description && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-600">{b.approval.description}</p>
                  )}
                  {b.decision ? (
                    <p className="mt-2 text-xs font-medium text-zinc-600">
                      {b.decision.startsWith("allow") ? "✓ 已允许" : b.decision === "deny" ? "✕ 已拒绝" : `已处理（${b.decision}）`}
                    </p>
                  ) : denyingId === b.approval.id ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={denyReason}
                        onChange={(e) => setDenyReason(e.target.value)}
                        maxLength={500}
                        rows={2}
                        autoFocus
                        placeholder="拒绝理由（可选，会告知 AI 以便它调整方案）"
                        className="w-full resize-none rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:border-zinc-500 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={b.resolving}
                          onClick={() => decideApproval(b.approval.id, "deny", denyReason)}
                          className="rounded-md bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-40"
                        >
                          确认拒绝
                        </button>
                        <button
                          onClick={() => { setDenyingId(null); setDenyReason(""); }}
                          className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {b.approval.allowedDecisions.map((d) => (
                        <button
                          key={d}
                          disabled={b.resolving}
                          onClick={() => {
                            if (d === "deny") {
                              setDenyingId(b.approval.id);
                              setDenyReason("");
                            } else {
                              decideApproval(b.approval.id, d);
                            }
                          }}
                          className={`rounded-md px-3 py-1 text-xs disabled:opacity-40 ${
                            d === "deny"
                              ? "border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                              : "bg-zinc-900 text-white hover:bg-zinc-700"
                          }`}
                        >
                          {decisionLabel[d] ?? d}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          return (
            <p key={i} className="text-center text-xs text-zinc-400">
              {b.text}
            </p>
          );
        })}
        {streaming &&
          (() => {
            const last = bubbles[bubbles.length - 1];
            const activelyRendering =
              (last?.kind === "assistant" && last.streaming) ||
              (last?.kind === "tool" && !last.done) ||
              (last?.kind === "approval" && !last.decision);
            if (activelyRendering) return null;
            return (
              <div className="flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-3">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
                </div>
              </div>
            );
          })()}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-[var(--line)] p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={Math.min(6, Math.max(1, input.split("\n").length))}
            placeholder={streaming ? "回复中，输入消息将注入本轮…" : "输入消息，Enter 发送"}
            className="max-h-40 flex-1 resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          {streaming ? (
            <button
              onClick={abort}
              className="shrink-0 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              停止
            </button>
          ) : null}
          <button
            onClick={send}
            disabled={!input.trim()}
            className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
