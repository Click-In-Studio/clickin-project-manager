"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import Markdown from "@/components/Markdown";
import {
  applyStreamLine,
  type Bubble,
  type QuestionInfo,
  type QuestionItem,
  type StreamLine,
} from "@/lib/agent-chat/stream-reducer";
import { parseSessionIdentity } from "@/lib/agent-tools/session-identity";
import { buildUiContextMessage } from "@/lib/agent-ui-context";
import { derivePageKey, pageLabelFor, pageSuggestionsFor } from "@/lib/agent-page-context";
import { toolLabel } from "@/lib/agent-tool-labels";
import { dispatchAgentMutation } from "@/lib/agent-mutations";
import WikiProposalPreviewModal from "@/components/WikiProposalPreviewModal";
import ChevronIcon from "@/components/ChevronIcon";

/** 按语境（个人 / 某个制作）分桶持久化最后一次活跃会话，重开 popout 时恢复。 */
function lastSessionStorageKey(productionId: string | null): string {
  return `clickin-ai-last-session:${productionId ?? "personal"}`;
}

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
  onRequestOpen,
  productionId,
  productionName,
  currentWikiId,
}: {
  open: boolean;
  onClose: () => void;
  /** 深链（?agentSession=<key>，定时任务通知带的）要求把 popout 打开 */
  onRequestOpen?: () => void;
  productionId: string | null;
  productionName: string | null;
  /** 当前所在的 wiki 文档页 id（非文档页/文档库根页为 null）——驱动"附带当前文档" chip。 */
  currentWikiId: string | null;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewToolCallId, setPreviewToolCallId] = useState<string | null>(null);
  const [currentDocTitle, setCurrentDocTitle] = useState<string | null>(null);
  const [currentDocTags, setCurrentDocTags] = useState<string[]>([]);
  const [docAttached, setDocAttached] = useState(true);
  const [pageAttached, setPageAttached] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const pathname = usePathname();
  const router = useRouter();

  // 页面感知（「主动就位、被动发言」）：pageKey/label 来自 allowlist 注册表
  // （lib/agent-page-context.ts），不在表里的页面什么都不附带。建议 chip 点击
  // 只填入输入框、绝不自动发送；页面信息只随用户下一条真实消息的信封附带。
  const pageKey = derivePageKey(pathname ?? "", productionId);
  const pageLabel = pageLabelFor(pageKey);
  const pageSuggestions = pageSuggestionsFor(pageKey);

  // 换页面后默认重新勾选附带（与文档 chip 同款语义）。
  useEffect(() => {
    setPageAttached(true);
  }, [pageKey]);

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

  // 按语境记住最后一次活跃的会话——重开 popout/刷新页面后自动接回去，
  // 不用每次都从空白开始。恢复逻辑见下面依赖 openSession 的那个 effect。
  useEffect(() => {
    if (!activeKey) return;
    try { localStorage.setItem(lastSessionStorageKey(productionId), activeKey); } catch { /* 配额满等，忽略 */ }
  }, [activeKey, productionId]);

  // 附带当前文档 chip：换文档/离开文档页时重取标题+tag、默认重新勾选附带。
  // 只取标题/tag/id——不拉正文（下面注释解释为什么）。
  useEffect(() => {
    if (!currentWikiId || !productionId) { setCurrentDocTitle(null); setCurrentDocTags([]); return; }
    setDocAttached(true);
    let alive = true;
    fetch(`/api/production/${productionId}/wiki/${currentWikiId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { wiki?: { title: string | null; tags?: string[] } } | null) => {
        if (!alive) return;
        setCurrentDocTitle(data?.wiki?.title ?? null);
        setCurrentDocTags(data?.wiki?.tags ?? []);
      })
      .catch(() => { if (alive) { setCurrentDocTitle(null); setCurrentDocTags([]); } });
    return () => { alive = false; };
  }, [currentWikiId, productionId]);

  // 点击 popout 外部不自动收起——和左侧剧本页折叠导航的浮出面板同一套交互
  // 惯例，只能靠 ✕ 按钮或再点一次 AI 按钮关掉。Escape 仍保留（标准可访问性
  // 惯例，和"点外面"是两回事，不在这次要去掉的范围内）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, streaming]);

  // 输入框随内容平滑长高（ChatGPT 等主流 webchat 的惯例），封顶后转内部滚动。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

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
    // 写操作后自动刷新（#367 自建运行时的形态）：runner 在写工具成功后发 `mutation` 行
    // （落 agent_event，断线重连可补），这里只派发给页面订阅者（lib/agent-mutations.ts），
    // 由它们决定刷新粒度；没人接才 router.refresh() 兜底。多个变更 300ms 内合并成一次兜底。
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const onMutation = (line: Extract<StreamLine, { type: "mutation" }>) => {
      const handled = dispatchAgentMutation({
        scope: line.scope, action: line.action, productionId: line.productionId ?? null, ids: line.ids, tool: line.tool,
      });
      if (handled || fallbackTimer) return;
      fallbackTimer = setTimeout(() => { fallbackTimer = null; router.refresh(); }, 300);
    };

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
            if (line.type === "mutation") onMutation(line); // 派发刷新；带 summary 的再由 reducer 渲成 notice
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
  }, [refreshSessions, router]);

  const openSession = useCallback(async (key: string, status?: SessionSummary["status"]) => {
    setPickerOpen(false);
    setActiveKey(key);
    setBubbles([]);
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/agent/chat/history?sessionKey=${encodeURIComponent(key)}`);
      if (res.ok) {
        const data = (await res.json()) as {
          messages: ({ role: "user" | "assistant"; content: string } | { role: "tool"; name: string; id?: string; result?: string })[];
        };
        if (activeKeyRef.current !== key) return;
        setBubbles(
          data.messages.map((m) =>
            m.role === "tool"
              ? { kind: "tool", name: m.name, id: m.id, done: true, ...(m.result ? { result: m.result } : {}) }
              : { kind: m.role, text: m.content }
          )
        );
      }
    } finally {
      if (activeKeyRef.current === key) setLoadingHistory(false);
    }
    if (status === "running") {
      // 待答的 ask_user 问题卡片先恢复再接流：question.list 是真实事实来源，
      // 卡片看不见就等于 agent 在隐形卡死（run 阻塞在 waitAnswer 直到过期）。
      // 经 reducer 注入以复用按 id 去重——实时 question 事件再来也不会重卡。
      try {
        const qres = await fetch(`/api/agent/questions?sessionKey=${encodeURIComponent(key)}`);
        if (qres.ok) {
          const data = (await qres.json()) as { questions?: QuestionInfo[] };
          if (activeKeyRef.current === key && data.questions?.length) {
            setBubbles((prev) =>
              data.questions!.reduce((acc, q) => applyStreamLine(acc, { type: "question", question: q }), prev)
            );
          }
        }
      } catch {
        // 恢复失败不挡接流；卡片还有实时事件这条路
      }
      const res = await fetch(`/api/agent/chat/stream?sessionKey=${encodeURIComponent(key)}`);
      consumeStream(res, key);
    }
  }, [consumeStream]);

  // 深链打开指定会话：定时任务的通知带 ?agentSession=<key>（lib/agent-runtime/schedules.ts）。
  // 只认属于当前语境的 key；用完从 URL 摘掉，免得刷新/返回又触发。状态从会话列表现查
  // （running 要接流），列表拉不到就按已结束打开。
  useEffect(() => {
    let key: string | null = null;
    try { key = new URLSearchParams(window.location.search).get("agentSession"); } catch { return; }
    if (!key || !inScope(key)) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("agentSession");
      window.history.replaceState(null, "", url.toString());
    } catch { /* 忽略 */ }
    onRequestOpen?.();
    const wanted = key;
    (async () => {
      let status: SessionSummary["status"] | undefined;
      try {
        const res = await fetch("/api/agent/sessions");
        if (res.ok) {
          const data = (await res.json()) as { sessions: SessionSummary[] };
          setSessions(data.sessions);
          status = data.sessions.find((s) => s.key === wanted)?.status;
        }
      } catch { /* 列表拉不到不挡打开 */ }
      openSession(wanted, status);
    })();
    // 只在路径变化时看一次 URL 参数（通知链接是整页加载或 push 过来的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // 恢复上次活跃会话：session 列表拉到、当前还没有 activeKey 时，若这个
  // 语境存过一个还在（没被删/没过期出 scopedSessions）的会话 id，接回去。
  useEffect(() => {
    if (activeKey || sessions.length === 0) return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(lastSessionStorageKey(productionId)); } catch { /* 忽略 */ }
    if (!stored) return;
    const match = scopedSessions.find((s) => s.key === stored);
    if (match) openSession(match.key, match.status);
  }, [sessions, productionId, activeKey, scopedSessions, openSession]);

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
    const raw = input.trim();
    if (!raw) return;
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
    setBubbles((prev) => [...prev, { kind: "user", text: raw }]); // 气泡显示原始输入，附带内容不进可见文本

    // 附带界面状态：页面只带一个中文页面名；文档只带标题/tag/id 这几个指针
    // 字段，不塞正文——AI 已经有 wiki_read(id) 工具，需要正文自己按 id 取；
    // 把整篇文章暴力拼进每条消息既浪费 token，文档一大还可能顶爆上下文。
    // 信封形态与"为什么挂在用户消息上而不是 system prompt"见 lib/agent-ui-context.ts。
    const message = buildUiContextMessage(raw, {
      pageLabel: pageAttached ? pageLabel : null,
      doc:
        docAttached && currentWikiId && currentDocTitle
          ? { wikiId: currentWikiId, title: currentDocTitle, tags: currentDocTags }
          : null,
    });

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
  }, [input, activeKey, streaming, consumeStream, productionId, docAttached, currentWikiId, currentDocTitle, currentDocTags, pageAttached, pageLabel]);

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

  // 「AI 偏好」= 个人级 agents.md（制作级在制作设置页，系统级不在线编辑）。
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefsText, setPrefsText] = useState("");
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const openPrefs = useCallback(async () => {
    setPrefsOpen(true);
    setPrefsBusy(true);
    setPrefsError(null);
    try {
      const res = await fetch("/api/agent/instructions");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { user?: string };
      setPrefsText(data.user ?? "");
    } catch {
      setPrefsError("读取失败，请重试");
    } finally {
      setPrefsBusy(false);
    }
  }, []);

  const savePrefs = useCallback(async () => {
    setPrefsBusy(true);
    setPrefsError(null);
    const res = await fetch("/api/agent/instructions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "user", content: prefsText }),
    }).catch(() => null);
    setPrefsBusy(false);
    if (!res?.ok) {
      const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setPrefsError(err.error || "保存失败，请重试");
      return;
    }
    setPrefsOpen(false);
  }, [prefsText]);

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

  const answerQuestion = useCallback(
    async (questionId: string, payload: { answers: Record<string, string[]> } | { cancel: true }) => {
      setBubbles((prev) =>
        prev.map((b) => (b.kind === "question" && b.question.id === questionId ? { ...b, resolving: true } : b))
      );
      const res = await fetch("/api/agent/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: questionId, ...payload }),
      }).catch(() => null);
      if (!res?.ok) {
        const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
        setBubbles((prev) =>
          prev.map((b) => (b.kind === "question" && b.question.id === questionId ? { ...b, resolving: false } : b))
        );
        setBubbles((prev) => [...prev, { kind: "notice", text: err.error || "回答提交失败" }]);
        return;
      }
      // 乐观翻状态；question-resolved 事件回来会按 id 再翻一次（幂等）。
      // 事件仍然要转发渲染——回答也可能来自别的 OpenClaw 客户端。
      const status = "cancel" in payload ? "cancelled" : "answered";
      setBubbles((prev) =>
        prev.map((b) =>
          b.kind === "question" && b.question.id === questionId ? { ...b, status, resolving: false } : b
        )
      );
    },
    []
  );

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
            onClick={() => openPrefs()}
            title="AI 偏好（个人指令）"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--surface)] text-sm text-[var(--muted)] hover:bg-[var(--paper)]"
          >
            ⚙
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
                <ToolCallBubble name={b.name} done={b.done} isError={b.isError} input={b.input} result={b.result} />
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
            // 按钮由后端的 allowedDecisions 驱动，恒为 allow-once / deny（"始终允许"
            // 需要持久化那一半，没做就不给按钮，见 lib/agent-runtime/approvals.ts）
            const decisionLabel: Record<string, string> = {
              "allow-once": "允许一次",
              deny: "拒绝",
            };
            return (
              <div key={i} className="flex justify-start">
                <div className={`max-w-[92%] rounded-xl border px-3.5 py-3 text-sm ${severityStyle}`}>
                  <p className="font-medium text-zinc-800">⚠ 需要确认：{b.approval.title}</p>
                  {b.approval.description && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-600">{b.approval.description}</p>
                  )}
                  {/* 不是所有 approval 都对应一个 wiki proposal（未来会有别的写工具）——
                      按钮始终渲染，找不到详情让 modal 自己兜底，省一次预探测往返。 */}
                  {b.approval.toolCallId && productionId && (
                    <button
                      onClick={() => setPreviewToolCallId(b.approval.toolCallId!)}
                      className="mt-1.5 text-[11px] font-medium text-zinc-500 underline hover:text-zinc-800"
                    >
                      查看详情
                    </button>
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
          if (b.kind === "question") {
            return (
              <div key={i} className="flex justify-start">
                <QuestionCard
                  question={b.question}
                  status={b.status}
                  resolving={b.resolving}
                  onSubmit={(answers) => answerQuestion(b.question.id, { answers })}
                  onCancel={() => answerQuestion(b.question.id, { cancel: true })}
                />
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
              (last?.kind === "approval" && !last.decision) ||
              (last?.kind === "question" && !last.status);
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

      {/* 页面感知栏：本页建议（点击填入输入框，不发送）+ 附带 chip（页面/文档，
          默认勾选、可点掉——附带的内容对用户始终可见、可摘除）。 */}
      {(pageLabel || (currentWikiId && currentDocTitle) || pageSuggestions.length > 0) && (
        <div className="shrink-0 space-y-1.5 border-t border-[var(--line)] bg-[var(--paper)] px-3 py-1.5">
          {pageSuggestions.length > 0 && input.trim() === "" && (
            <div className="flex flex-wrap gap-1.5">
              {pageSuggestions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  title="点击填入输入框（不会直接发送）"
                  onClick={() => {
                    setInput(s.prompt);
                    textareaRef.current?.focus();
                  }}
                  className="rounded-full border border-dashed border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--muted)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)]"
                >
                  ✨ {s.label}
                </button>
              ))}
            </div>
          )}
          {(pageLabel || (currentWikiId && currentDocTitle)) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {pageLabel && (
                <button
                  type="button"
                  onClick={() => setPageAttached((v) => !v)}
                  title={pageAttached ? "点击取消附带当前页面" : "点击重新附带当前页面"}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    pageAttached
                      ? "border-[var(--ink)] bg-[var(--surface)] text-[var(--ink)]"
                      : "border-[var(--line)] text-[var(--muted)] line-through"
                  }`}
                >
                  📍 {pageLabel}
                </button>
              )}
              {currentWikiId && currentDocTitle && (
                <button
                  type="button"
                  onClick={() => setDocAttached((v) => !v)}
                  title={docAttached ? "点击取消附带" : "点击重新附带"}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    docAttached
                      ? "border-[var(--ink)] bg-[var(--surface)] text-[var(--ink)]"
                      : "border-[var(--line)] text-[var(--muted)] line-through"
                  }`}
                >
                  📎 附带《{currentDocTitle}》
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-[var(--line)] p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={streaming ? "回复中，输入消息将注入本轮…" : "输入消息，Enter 发送"}
            className="max-h-40 flex-1 resize-none overflow-y-auto rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
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

      {previewToolCallId && productionId && (
        <WikiProposalPreviewModal
          open={!!previewToolCallId}
          onClose={() => setPreviewToolCallId(null)}
          productionId={productionId}
          toolCallId={previewToolCallId}
        />
      )}

      {/* portal 到 body：popout 容器带 transition-transform，transform 祖先会成为
          fixed 子孙的 containing block——不传送的话这个 modal 会被困在 440px
          侧栏里看不全（WikiProposalPreviewModal 同款问题同款修法）。 */}
      {prefsOpen && createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onClick={() => !prefsBusy && setPrefsOpen(false)}>
          <div
            className="w-[520px] max-w-[92vw] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-[var(--ink)]">AI 偏好（个人指令）</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              写给 AI 助手的个人指令，在你的所有会话中生效。语言、语气、回复习惯等都可以写；
              与制作级指令冲突时以制作级为准。指令不会改变你的任何权限。
            </p>
            <textarea
              value={prefsText}
              onChange={(e) => setPrefsText(e.target.value)}
              disabled={prefsBusy}
              maxLength={4000}
              rows={10}
              placeholder="例如：回复保持简短；专业术语保留英文原文；列清单时不超过 5 条…"
              className="mt-3 w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none disabled:opacity-50"
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] text-[var(--muted)]">{prefsText.length}/4000</span>
              {prefsError && <span className="text-[11px] text-[var(--danger)]">{prefsError}</span>}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setPrefsOpen(false)}
                disabled={prefsBusy}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"
              >
                取消
              </button>
              <button
                onClick={savePrefs}
                disabled={prefsBusy}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-40"
              >
                {prefsBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 调用参数里插件注入的调用者身份字段（_caller_user_id 等）——对模型是
 * 强制覆写的信道，对用户是噪声，展示时剥掉。 */
function stripCallerFields(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith("_caller_")) continue;
    out[k] = val;
  }
  return out;
}

/** 参数/结果 → 可读文本：MCP 结果对象取其 text 块；relay 的截断包裹标注
 * "已截断"（preview 是掐断的 JSON 碎片、语法不保证完整，只能当纯文本渲染，
 * 永远不得 JSON.parse——relay 侧 boundToolPayload 注释同款约定）；其余
 * JSON pretty-print。空/无内容返回 ""（调用方隐藏该栏）。 */
function formatToolPayload(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (rec.truncated === true && typeof rec.preview === "string") {
      return `${rec.preview}\n…（内容过长，已截断）`;
    }
    if (Array.isArray(rec.content)) {
      const texts = (rec.content as unknown[])
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null &&
            (b as Record<string, unknown>).type === "text" &&
            typeof (b as Record<string, unknown>).text === "string",
        )
        .map((b) => b.text);
      if (texts.length > 0) return texts.join("\n");
    }
    if (Object.keys(rec).length === 0) return "";
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 工具调用气泡：中文显示名 + 状态（转圈/✓/✗），有参数或结果时可点开
 * 查看详情（openclaw dashboard 同款交互——不需要确认的调用也能看）。 */
function ToolCallBubble({
  name,
  done,
  isError,
  input,
  result,
}: {
  name: string;
  done: boolean;
  isError?: boolean;
  input?: unknown;
  result?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputText = formatToolPayload(stripCallerFields(input));
  const resultText = formatToolPayload(result);
  const hasDetail = inputText !== "" || resultText !== "";
  const failed = done && isError;

  const statusIcon = failed ? (
    <span className="text-red-500">✗</span>
  ) : done ? (
    "✓"
  ) : (
    <span className="inline-block h-2 w-2 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
  );

  return (
    <div className="max-w-[92%]">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={hasDetail ? (expanded ? "收起详情" : "查看详情") : undefined}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
          failed ? "border-red-200 bg-red-50 text-red-600" : "border-zinc-200 bg-zinc-50 text-zinc-500"
        } ${hasDetail ? "cursor-pointer hover:border-zinc-400 hover:text-zinc-700" : "cursor-default"}`}
      >
        {statusIcon}
        {toolLabel(name)}
        {hasDetail && <ChevronIcon direction={expanded ? "up" : "down"} size={10} />}
      </button>
      {expanded && hasDetail && (
        <div className="mt-1 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
          <p className="font-mono text-[10px] text-zinc-400">{name}</p>
          {inputText !== "" && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">参数</p>
              <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-zinc-600">
                {inputText}
              </pre>
            </div>
          )}
          {resultText !== "" && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">
                {failed ? "结果（失败）" : "结果"}
              </p>
              <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-zinc-600">
                {resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** ask_user 问题卡片：AI 主动向人索取输入，run 阻塞到有人回答或问题过期
 * （默认 15 分钟）。单题单选且不允许自由文本时点选项即提交；其余情况选完
 * 按"提交回答"。
 *
 * 曾有一支 isSecret（password 输入框、不回显）——那是照着网关 question.* 协议
 * 写的前向兼容代码。自建运行时的 ask_user schema 刻意不带这个字段：回答会原样
 * 进工具结果与 transcript 落库，"不回显"根本兑现不了；助手也没有任何索取凭据的
 * 正当理由（TOOLS.md 已明写不要问）。要加回来先解决落库明文问题。 */
function QuestionCard({
  question,
  status,
  resolving,
  onSubmit,
  onCancel,
}: {
  question: QuestionInfo;
  status?: string;
  resolving?: boolean;
  onSubmit: (answers: Record<string, string[]>) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const quickSubmit =
    question.questions.length === 1 && !question.questions[0].multiSelect && !question.questions[0].isOther;

  const toggle = (item: QuestionItem, label: string) => {
    if (quickSubmit) {
      onSubmit({ [item.questionId]: [label] });
      return;
    }
    setSelected((prev) => {
      const cur = prev[item.questionId] ?? [];
      const next = item.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label];
      return { ...prev, [item.questionId]: next };
    });
  };

  // 每题必答（选项或自由文本至少一样）才可提交；凑不齐返回 null。
  const collectAnswers = (): Record<string, string[]> | null => {
    const out: Record<string, string[]> = {};
    for (const item of question.questions) {
      const chosen = [...(selected[item.questionId] ?? [])];
      const other = (otherText[item.questionId] ?? "").trim();
      if (other) chosen.push(other);
      if (chosen.length === 0) return null;
      out[item.questionId] = chosen;
    }
    return out;
  };
  const ready = collectAnswers() !== null;

  if (status) {
    const label =
      status === "answered" ? "✓ 已回答" : status === "cancelled" ? "已取消提问" : status === "expired" ? "已过期" : `已处理（${status}）`;
    return (
      <div className="max-w-[92%] rounded-xl border border-indigo-200 bg-indigo-50/60 px-3.5 py-3 text-sm">
        <p className="font-medium text-zinc-800">❓ AI 提问{question.questions.length > 1 ? `（${question.questions.length} 题）` : `：${question.questions[0]?.question ?? ""}`}</p>
        <p className="mt-1.5 text-xs font-medium text-zinc-600">{label}</p>
      </div>
    );
  }

  return (
    <div className="max-w-[92%] rounded-xl border border-indigo-300 bg-indigo-50 px-3.5 py-3 text-sm">
      <p className="font-medium text-zinc-800">❓ AI 需要你的选择才能继续</p>
      {question.questions.map((item) => (
        <div key={item.questionId} className="mt-2">
          <p className="text-xs text-zinc-700">
            <span className="mr-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700">
              {item.header}
            </span>
            {item.question}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {item.options.map((opt) => {
              const active = (selected[item.questionId] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  disabled={resolving}
                  title={opt.description}
                  onClick={() => toggle(item, opt.label)}
                  className={`rounded-md px-2.5 py-1 text-xs disabled:opacity-40 ${
                    active
                      ? "bg-indigo-600 text-white"
                      : "border border-indigo-300 bg-white text-zinc-700 hover:bg-indigo-100"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {item.isOther && (
            <input
              type="text"
              autoComplete="off"
              value={otherText[item.questionId] ?? ""}
              onChange={(e) => setOtherText((prev) => ({ ...prev, [item.questionId]: e.target.value }))}
              placeholder="其他：自由输入…"
              className="mt-1.5 w-full rounded-md border border-indigo-200 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
            />
          )}
        </div>
      ))}
      <div className="mt-2.5 flex gap-2">
        {!quickSubmit && (
          <button
            disabled={resolving || !ready}
            onClick={() => {
              const answers = collectAnswers();
              if (answers) onSubmit(answers);
            }}
            className="rounded-md bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            提交回答
          </button>
        )}
        <button
          disabled={resolving}
          onClick={onCancel}
          className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"
        >
          取消提问
        </button>
      </div>
    </div>
  );
}
