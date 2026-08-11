"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";

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

type ApprovalInfo = {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  allowedDecisions: string[];
};

type Bubble =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; name: string; id?: string; done: boolean }
  | { kind: "approval"; approval: ApprovalInfo; decision?: string; resolving?: boolean }
  | { kind: "notice"; text: string };

type StreamLine =
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "aborted"; text: string }
  | { type: "error"; error: string }
  | { type: "tool"; name?: string; id?: string }
  | { type: "tool-end"; id?: string }
  | { type: "approval"; approval?: ApprovalInfo }
  | { type: "approval-resolved"; id?: string; decision?: string }
  | { type: "ping" };

export default function AgentChatClient() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[]; gatewayStatus?: GatewayStatus };
      setSessions(data.sessions);
      if (data.gatewayStatus) setGatewayStatus(data.gatewayStatus);
    } catch {
      // network hiccup — sidebar just stays stale
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, streaming]);

  // Reads one NDJSON chat stream into the bubble list. Shared by "send" and
  // "attach to running session".
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

    // 静默看门狗：服务端每 15s 发 ping，60s 收不到任何字节视为连接已死
    // （如 pm2 重启掐断流），cancel 让 read() 解除阻塞、finally 复位状态——
    // 否则 streaming 永远卡 true，后续消息全走 steer 打进虚空。
    let lastByteAt = Date.now();
    let watchdogFired = false;
    const watchdog = setInterval(() => {
      if (!watchdogFired && Date.now() - lastByteAt > 60_000) {
        watchdogFired = true; // cancel 一次即可，read() 解除阻塞后 finally 收尾
        reader.cancel().catch(() => {});
      }
    }, 5_000);

    const apply = (line: StreamLine) => {
      // A stale stream for a session the user already switched away from
      // must not touch the current transcript.
      if (activeKeyRef.current !== forKey) return;
      setBubbles((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        switch (line.type) {
          case "delta": {
            if (last?.kind === "assistant" && last.streaming) {
              next[next.length - 1] = { kind: "assistant", text: line.text, streaming: true };
            } else {
              next.push({ kind: "assistant", text: line.text, streaming: true });
            }
            return next;
          }
          case "tool": {
            // Current streaming segment (if any) is settled by this tool call.
            if (last?.kind === "assistant" && last.streaming) {
              next[next.length - 1] = { kind: "assistant", text: last.text };
            }
            next.push({ kind: "tool", name: line.name || "工具", id: line.id, done: false });
            return next;
          }
          case "tool-end": {
            for (let i = next.length - 1; i >= 0; i--) {
              const b = next[i];
              if (b.kind === "tool" && !b.done && (!line.id || b.id === line.id)) {
                next[i] = { ...b, done: true };
                break;
              }
            }
            return next;
          }
          case "final": {
            if (last?.kind === "assistant" && last.streaming) {
              next[next.length - 1] = { kind: "assistant", text: line.text || last.text };
            } else if (line.text) {
              next.push({ kind: "assistant", text: line.text });
            }
            return next;
          }
          case "approval": {
            if (!line.approval) return next;
            // Settle the current streaming segment; the gate pauses the run.
            if (last?.kind === "assistant" && last.streaming) {
              next[next.length - 1] = { kind: "assistant", text: last.text };
            }
            next.push({ kind: "approval", approval: line.approval });
            return next;
          }
          case "approval-resolved": {
            for (let i = next.length - 1; i >= 0; i--) {
              const b = next[i];
              if (b.kind === "approval" && b.approval.id === line.id) {
                next[i] = { ...b, decision: line.decision || "unknown", resolving: false };
                break;
              }
            }
            return next;
          }
          case "aborted": {
            if (last?.kind === "assistant" && last.streaming) {
              next[next.length - 1] = { kind: "assistant", text: last.text };
            }
            next.push({ kind: "notice", text: "已中止" });
            return next;
          }
          case "error": {
            if (last?.kind === "assistant" && last.streaming) {
              next[next.length - 1] = { kind: "assistant", text: last.text };
            }
            next.push({ kind: "notice", text: line.error || "出错了" });
            return next;
          }
          default:
            return next; // ping 等非渲染事件在上游已过滤，这里兜底
        }
      });
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
          if (!raw.trim()) continue;
          try {
            const line = JSON.parse(raw) as StreamLine;
            if (line.type === "ping") continue; // 心跳只喂看门狗
            apply(line);
          } catch {
            // skip malformed line
          }
        }
      }
    } finally {
      clearInterval(watchdog);
      setStreaming(false);
      // Settle any bubble still marked streaming (connection dropped).
      setBubbles((prev) =>
        prev.map((b) => (b.kind === "assistant" && b.streaming ? { kind: "assistant", text: b.text } : b))
      );
      refreshSessions();
    }
  }, [refreshSessions]);

  const openSession = useCallback(async (key: string, status?: SessionSummary["status"]) => {
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
    // Mid-reply session: attach to the live stream so it keeps rendering.
    if (status === "running") {
      const res = await fetch(`/api/agent/chat/stream?sessionKey=${encodeURIComponent(key)}`);
      consumeStream(res, key);
    }
  }, [consumeStream]);

  const newSession = useCallback(async () => {
    const res = await fetch("/api/agent/sessions", { method: "POST" });
    if (!res.ok) return;
    const { key } = (await res.json()) as { key: string };
    setActiveKey(key);
    setBubbles([]);
  }, []);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message) return;
    let key = activeKey;
    if (!key) {
      const res = await fetch("/api/agent/sessions", { method: "POST" });
      if (!res.ok) return;
      ({ key } = (await res.json()) as { key: string });
      setActiveKey(key);
    }
    setInput("");
    setBubbles((prev) => [...prev, { kind: "user", text: message }]);

    // streaming === true → there's a run in flight; inject via steer instead
    // of waiting (the already-open stream connection carries the extra reply).
    const res = await fetch("/api/agent/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: key, message, steer: streaming || undefined }),
    });
    if (streaming) {
      // Steer returns plain JSON (no second stream) — only surface failures.
      const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !out?.ok) {
        setBubbles((prev) => [...prev, { kind: "notice", text: out?.error || "消息注入失败，请等本轮结束后重发" }]);
      }
    } else {
      consumeStream(res, key);
    }
  }, [input, activeKey, streaming, consumeStream]);

  const abort = useCallback(async () => {
    if (!activeKey) return;
    await fetch("/api/agent/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: activeKey }),
    }).catch(() => {});
  }, [activeKey]);

  const decideApproval = useCallback(async (approvalId: string, decision: string) => {
    setBubbles((prev) =>
      prev.map((b) => (b.kind === "approval" && b.approval.id === approvalId ? { ...b, resolving: true } : b))
    );
    const res = await fetch("/api/agent/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approvalId, decision }),
    }).catch(() => null);
    if (!res?.ok) {
      const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setBubbles((prev) =>
        prev.map((b) => (b.kind === "approval" && b.approval.id === approvalId ? { ...b, resolving: false } : b))
      );
      setBubbles((prev) => [...prev, { kind: "notice", text: err.error || "确认请求处理失败" }]);
    }
    // 成功路径不在这里改状态——等 approval-resolved 流事件（权威来源）更新卡片
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

  const statusBanner = (() => {
    if (!gatewayStatus || gatewayStatus.state === "connected") return null;
    const text =
      gatewayStatus.state === "unconfigured"
        ? "AI 网关未配置（缺少 OPENCLAW_GATEWAY_TOKEN）"
        : gatewayStatus.state === "pairing_required"
          ? `AI 网关等待配对确认${gatewayStatus.requestId ? `（请求 ${gatewayStatus.requestId}）` : ""}`
          : gatewayStatus.state === "error"
            ? `AI 网关连接失败：${gatewayStatus.error}`
            : "AI 网关未连接";
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        {text}
      </div>
    );
  })();

  return (
    <div className="mx-auto flex h-[calc(100dvh-6rem)] max-w-6xl gap-4 p-4">
      {/* 会话列表 */}
      <aside className="flex w-64 shrink-0 flex-col rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 p-3">
          <span className="text-sm font-medium text-zinc-700">对话</span>
          <button
            onClick={newSession}
            className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs text-white hover:bg-zinc-700"
          >
            新对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-zinc-400">还没有对话</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.key}
              className={`group mb-1 cursor-pointer rounded-md px-2 py-2 text-sm ${
                s.key === activeKey ? "bg-zinc-100" : "hover:bg-zinc-50"
              }`}
              onClick={() => openSession(s.key, s.status)}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-zinc-800">
                  {s.status === "running" && <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
                  {s.title}
                </span>
                <span className="hidden shrink-0 gap-1 group-hover:flex">
                  <button
                    onClick={(e) => { e.stopPropagation(); renameSession(s.key, s.title); }}
                    className="text-xs text-zinc-400 hover:text-zinc-600"
                    title="重命名"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeSession(s.key); }}
                    className="text-xs text-zinc-400 hover:text-red-500"
                    title="删除"
                  >
                    ✕
                  </button>
                </span>
              </div>
              {s.lastMessagePreview && (
                <p className="mt-0.5 truncate text-xs text-zinc-400">{s.lastMessagePreview}</p>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* 聊天区 */}
      <main className="flex min-w-0 flex-1 flex-col rounded-lg border border-zinc-200 bg-white">
        {statusBanner && <div className="p-3">{statusBanner}</div>}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {loadingHistory && <p className="text-center text-sm text-zinc-400">加载中…</p>}
          {!loadingHistory && bubbles.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-zinc-400">向团队 AI 助手提问吧</p>
            </div>
          )}
          {bubbles.map((b, i) => {
            if (b.kind === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-zinc-900 px-4 py-2 text-sm text-white">
                    {b.text}
                  </div>
                </div>
              );
            }
            if (b.kind === "assistant") {
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-2 text-sm">
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
                  <div className={`max-w-[85%] rounded-xl border px-4 py-3 text-sm ${severityStyle}`}>
                    <p className="font-medium text-zinc-800">⚠ 需要确认：{b.approval.title}</p>
                    {b.approval.description && (
                      <p className="mt-1 break-all text-xs text-zinc-500">{b.approval.description}</p>
                    )}
                    {b.decision ? (
                      <p className="mt-2 text-xs font-medium text-zinc-600">
                        {b.decision.startsWith("allow") ? "✓ 已允许" : b.decision === "deny" ? "✕ 已拒绝" : `已处理（${b.decision}）`}
                      </p>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        {b.approval.allowedDecisions.map((d) => (
                          <button
                            key={d}
                            disabled={b.resolving}
                            onClick={() => decideApproval(b.approval.id, d)}
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
          {/* 思考中：run 已发出但当前没有任何在流式渲染的气泡（等首 token、
              或工具刚结束还没吐后续文本）时的占位反馈 */}
          {streaming &&
            (() => {
              const last = bubbles[bubbles.length - 1];
              const activelyRendering =
                (last?.kind === "assistant" && last.streaming) ||
                (last?.kind === "tool" && !last.done) ||
                (last?.kind === "approval" && !last.decision); // 等人确认，不是在思考
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
        <div className="border-t border-zinc-200 p-3">
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
                className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                停止
              </button>
            ) : null}
            <button
              onClick={send}
              disabled={!input.trim()}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
