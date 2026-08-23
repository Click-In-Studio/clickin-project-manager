import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { GatewayClient } from "@openclaw/gateway-client";
import { readPairingConnectErrorDetails } from "@openclaw/gateway-protocol/connect-error-details";
import { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "@openclaw/gateway-protocol/client-info";
import { GATEWAY_URL, getGatewayToken, isGatewayConfigured } from "./config";
import * as device from "./device";
import type { ChatSessionSummary, ChatTranscriptEntry, GatewayStatus } from "./types";
import { TOOL_PAYLOAD_MAX_CHARS } from "./types";
import { PRODUCTION_ID_RE } from "@/lib/mcp/session-identity";
import { stripUiContext } from "@/lib/agent-ui-context";

/**
 * Server-only singleton Gateway connection (globalThis-cached so it survives
 * Next.js dev-mode module re-evaluation). Lazily connects on first use —
 * gateway chat is optional and a missing token must not block app startup.
 *
 * Team-gateway adaptation of MindWeave's single-user gatewayClient: every
 * session lives under a per-user namespace (clickin:chat:<userId>:) and all
 * session enumeration/access is scoped by userId. The backend is the ONLY
 * operator client — users never talk to the gateway directly — so this
 * prefix scoping plus the API routes' ownership checks form the entire
 * user-isolation boundary (OpenClaw's own multi-user features are explicitly
 * not a security boundary per its docs).
 */

// operator.admin is required for sessions.patch (rename) and sessions.delete —
// operator.read/write alone 403 on both (confirmed against a real gateway).
// operator.approvals is required to receive plugin.approval.requested/resolved
// broadcasts and to call approval.resolve — the /agent page is the ONLY
// approval surface for the team gateway (dashboard is disabled), so without
// it every gated write tool would fail closed.
// Deliberately requested up front for the whole connection: scopes are fixed
// per WS connection (a singleton here), so per-call scope narrowing isn't
// possible, and adding a scope later forces a re-pairing round.
const SCOPES = ["operator.read", "operator.write", "operator.admin", "operator.approvals"];

const SESSION_NAMESPACE = "clickin:chat:";


/** 个人会话：clickin:chat:<userId>:<uuid>
 *  production 会话：clickin:chat:<userId>:<productionId>:<uuid>
 * productionId 是后台 uid() 短字母数字串（无连字符，与末段 UUID 可判别）。
 * 成员资格校验在签发路由做——这里只负责格式（非法 id 直接抛，防 key 注入）。 */
export function createNewSessionKey(userId: string, productionId?: string): string {
  if (productionId !== undefined && !PRODUCTION_ID_RE.test(productionId)) {
    throw new Error(`invalid productionId for session key: ${productionId}`);
  }
  const mid = productionId ? `${productionId}:` : "";
  return `${SESSION_NAMESPACE}${userId}:${mid}${crypto.randomUUID()}`;
}

/**
 * True when `sessionKey` belongs to `userId`. Accepts both the bare form
 * (clickin:chat:<userId>:<uuid>) and the canonical agent-prefixed form the
 * gateway echoes back (agent:<agentId>:clickin:chat:<userId>:<uuid>).
 * userId is an app_user UUID (no colons), so prefix matching is unambiguous.
 */
export function sessionKeyOwnedBy(sessionKey: string, userId: string): boolean {
  const bare = sessionKey.replace(/^agent:[^:]+:/, "");
  return bare.startsWith(`${SESSION_NAMESPACE}${userId}:`);
}

/**
 * production 会话 → productionId，个人会话/非法 key → null。
 * 结构见 createNewSessionKey：namespace 后 2 段 = 个人（userId:uuid），
 * 3 段 = production（userId:productionId:uuid）。
 */
export function productionIdOfSessionKey(sessionKey: string): string | null {
  const bare = sessionKey.replace(/^agent:[^:]+:/, "");
  if (!bare.startsWith(SESSION_NAMESPACE)) return null;
  const parts = bare.slice(SESSION_NAMESPACE.length).split(":");
  return parts.length === 3 && PRODUCTION_ID_RE.test(parts[1]) ? parts[1] : null;
}

interface GatewayStore {
  client: GatewayClient | null;
  status: GatewayStatus;
  connecting: Promise<GatewayStatus> | null;
  // Per-session pub/sub for streaming chat events out to whichever relay
  // request is waiting on that session. Survives reconnects since it's
  // stored alongside the rest of the globalThis-cached state.
  events: EventEmitter;
  // Pending plugin approvals by approval id → owning sessionKey. Populated
  // from plugin.approval.requested broadcasts; consumed for the resolve API's
  // ownership check and cleared on plugin.approval.resolved. Bounded by the
  // gateway's own approval timeout (unresolved approvals always deny).
  pendingApprovals: Map<string, { sessionKey?: string; toolCallId?: string; ts: number }>;
  // 拒绝理由暂存（toolCallId → reason）：在 resolve RPC 之前写入，插件的
  // clickin-memory 经 MCP 同进程端点取走（一次性），用于把理由重写进
  // 被拒工具结果——与拒绝同帧到达模型，避免 steer 注入造成的双回复。
  denyReasons: Map<string, { reason: string; ts: number }>;
  // Steer expectations, owned by the relay connection that will wait for
  // them: each open relay registers a SteerOwner under its session key(s);
  // steerChatRun() bumps every owner currently listening on that session,
  // and each owner's count dies with its connection (release()). Ownership
  // instead of TTL: expectations can't outlive or undercut the connection
  // they belong to, however long an approval gate or tool call keeps it
  // open — no stale entry can make the session's NEXT stream swallow a
  // genuine final.
  steerOwners: Map<string, Set<SteerOwner>>;
  // question.requested → owning sessionKey, because question.resolved does
  // NOT carry a sessionKey and couldn't be routed without this. Entries are
  // bounded by the question's own expiresAtMs (gateway default 15min) — an
  // intrinsic lifetime, not a guess at someone else's. Reseeded from
  // question.list after a server restart (listSessionQuestions).
  questionSessions: Map<string, { sessionKey: string; expiresAtMs: number }>;
}

declare global {
  var __clickinAgentGateway: GatewayStore | undefined;
}

function store(): GatewayStore {
  if (!globalThis.__clickinAgentGateway) {
    const events = new EventEmitter();
    // Listener count is per event name (session:<key>) — normally 1-2 per
    // session, but the same session can be watched from multiple tabs, and
    // this is a multi-user process. Raise the cap so legitimate fan-out
    // never trips MaxListenersExceededWarning.
    events.setMaxListeners(100);
    globalThis.__clickinAgentGateway = {
      client: null,
      status: { state: isGatewayConfigured() ? "disconnected" : "unconfigured" },
      connecting: null,
      events,
      pendingApprovals: new Map(),
      denyReasons: new Map(),
      steerOwners: new Map(),
      questionSessions: new Map(),
    };
  }
  return globalThis.__clickinAgentGateway;
}

interface SteerOwner {
  pending: number;
}

export interface SteerOwnerHandle {
  /** Also listen for steers registered under `key` (the canonical form the
   * gateway echoes back, learned only after the run-start RPC). Idempotent. */
  attachKey(key: string): void;
  /** Called on every genuine (non-yielded) terminal event — true if there's
   * still at least one steered run this connection should keep waiting for,
   * having consumed one unit of that expectation. */
  consume(): boolean;
  /** Drops this owner and every expectation it held. Must run when the
   * connection closes, normal finish and client abort alike. */
  release(): void;
}

/** Registers a relay connection as the owner of this session's future steer
 * expectations. Ownership replaces the old TTL bookkeeping: the expectation
 * lives exactly as long as the connection that would consume it. */
export function createSteerOwner(sessionKey: string): SteerOwnerHandle {
  const s = store();
  const owner: SteerOwner = { pending: 0 };
  const keys = new Set<string>();
  const attachKey = (key: string) => {
    if (!key || keys.has(key)) return;
    keys.add(key);
    let set = s.steerOwners.get(key);
    if (!set) {
      set = new Set();
      s.steerOwners.set(key, set);
    }
    set.add(owner);
  };
  attachKey(sessionKey);
  return {
    attachKey,
    consume() {
      if (owner.pending <= 0) return false;
      owner.pending -= 1;
      return true;
    },
    release() {
      for (const key of keys) {
        const set = s.steerOwners.get(key);
        if (!set) continue;
        set.delete(owner);
        if (set.size === 0) s.steerOwners.delete(key);
      }
      keys.clear();
    },
  };
}

/** Tells every relay connection currently watching `sessionKey` to wait for
 * one more final (a steered run). Returns false when nobody is listening —
 * the steered run still executes, its reply just arrives via chat.history. */
export function markSteerPending(sessionKey: string): boolean {
  const owners = store().steerOwners.get(sessionKey);
  if (!owners || owners.size === 0) return false;
  for (const owner of owners) owner.pending += 1;
  return true;
}

export function getStatus(): GatewayStatus {
  if (!isGatewayConfigured()) return { state: "unconfigured" };
  return store().status;
}

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  state?: "status" | "delta" | "final" | "aborted" | "error";
  deltaText?: string;
  message?: { content?: unknown };
  // Set (to `true`) on a "final" that only closes one segment of a
  // multi-step turn (model paused to run a tool) rather than the whole
  // exchange. The official session-projection reducer only treats a final
  // as a true pause when `yielded === true && stopReason === "end_turn"`,
  // so the relay mirrors that exact condition.
  yielded?: true;
  stopReason?: string;
  errorMessage?: string;
}

// Tool-call lifecycle *and* the actual assistant text both arrive on a
// separate "agent" event channel (confirmed live by MindWeave):
//   { event: "agent", payload: { runId, sessionKey, stream: "item",
//     data: { itemId, phase: "start"|"end", kind: "tool", name, toolCallId, ... } } }
//   { event: "agent", payload: { runId, sessionKey, stream: "assistant",
//     data: { text, delta } } }   // text = cumulative, delta = new chars only
// The "chat" stream's message.content is NOT usable for text spanning a tool
// call: within one run it concatenates every text block together, so its
// delta/final text is a growing, duplicating blob once a tool call happened.
// The "agent"/"assistant" stream's `delta` is genuinely incremental, so
// subscribeToSession uses it as the source of truth once any tool call is
// seen, falling back to the "chat" stream only for plain no-tool replies.
interface AgentEventPayload {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: {
    kind?: string;
    phase?: string;
    name?: string;
    toolCallId?: string;
    itemId?: string;
    delta?: string;
    text?: string;
    replace?: boolean;
    // 仅 stream:"tool" 事件携带（gateway 源码 handleToolExecutionStart/End）：
    // phase "start" 带 args（sanitize 后的完整调用参数），phase "result" 带
    // result（MCP 结果对象）与 isError。stream:"item" 的 tool 条目不带这些。
    args?: unknown;
    result?: unknown;
    isError?: boolean;
  };
}

// plugin.approval.requested / plugin.approval.resolved broadcast payloads.
// The docs pin the event names and scope (operator.approvals) but not the
// exact field layout, so extraction below is defensive: id/title/etc. are
// looked up both flat and under a nested `request` object. Live-validated
// during Phase 4 rollout (AGENT_GATEWAY_DEBUG=1 shows the raw payload).
export interface ApprovalRequest {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  allowedDecisions: string[];
  sessionKey?: string;
  // 关联的工具调用 id——拒绝理由按它存取（gateway 的 resolve 协议不携带
  // 理由，理由经 MCP 同进程端点交给插件在 tool_result_persist 里重写）
  toolCallId?: string;
}

function extractApprovalRequest(payload: unknown): ApprovalRequest | null {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) return null;
  const nested = (p.request ?? {}) as Record<string, unknown>;
  const pick = (key: string): unknown => p[key] ?? nested[key];
  const id = pick("id") ?? pick("approvalId");
  if (typeof id !== "string" || !id) return null;
  const sessionKey = pick("sessionKey");
  const severity = pick("severity");
  const allowed = pick("allowedDecisions");
  const toolCallId = pick("toolCallId");
  return {
    id,
    title: String(pick("title") ?? "工具调用确认"),
    description: String(pick("description") ?? ""),
    severity: severity === "info" || severity === "critical" ? severity : "warning",
    allowedDecisions: Array.isArray(allowed) && allowed.length > 0
      ? allowed.map(String)
      : ["allow-once", "allow-always", "deny"],
    sessionKey: typeof sessionKey === "string" ? sessionKey : undefined,
    toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
  };
}

// ask_user 走的是独立于 tool 事件的 question.* 协议通道（MindWeave《OpenClaw
// ask_user 问题机制调研》）：工具侧阻塞在 question.waitAnswer 等人回答，没人
// 回答 = run 静默挂到问题过期（默认 15 分钟）。不路由这两个事件的后果不是
// "少一条通知"，而是一个看不见的卡死 run。scope 无需新增：本连接的
// operator.admin 在事件守卫与 RPC 鉴权处均被短路放行（实测结论见调研第三节）。
export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionItem {
  questionId: string;
  header: string;
  question: string;
  options: AgentQuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface AgentQuestionRecord {
  id: string;
  questions: AgentQuestionItem[];
  sessionKey?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  status: "pending" | "answered" | "cancelled" | "expired";
}

const QUESTION_DEFAULT_TTL_MS = 900_000; // gateway 默认 expiresAtMs - createdAtMs

function extractQuestionRecord(payload: unknown): AgentQuestionRecord | null {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) return null;
  // 防御式：record 可能平铺在 payload 上，也可能包在 question/record 字段里
  // （schema 里 QuestionRequestedEvent 是空对象，形状只能实测+防御）。
  const flat = typeof p.id === "string" && Array.isArray(p.questions) ? p : null;
  const nested = [p.question, p.record].find(
    (v) => v && typeof (v as Record<string, unknown>).id === "string" && Array.isArray((v as Record<string, unknown>).questions),
  ) as Record<string, unknown> | undefined;
  const r = flat ?? nested;
  if (!r) return null;
  return {
    id: r.id as string,
    questions: (r.questions as AgentQuestionItem[]).filter((q) => q && typeof q.question === "string"),
    sessionKey: typeof r.sessionKey === "string" ? r.sessionKey : undefined,
    createdAtMs: typeof r.createdAtMs === "number" ? r.createdAtMs : undefined,
    expiresAtMs: typeof r.expiresAtMs === "number" ? r.expiresAtMs : undefined,
    status: (r.status as AgentQuestionRecord["status"]) ?? "pending",
  };
}

function pruneQuestionSessions(s: GatewayStore): void {
  const now = Date.now();
  for (const [id, entry] of s.questionSessions) {
    if (now > entry.expiresAtMs) s.questionSessions.delete(id);
  }
}

function rememberQuestionSession(s: GatewayStore, record: AgentQuestionRecord): void {
  if (!record.sessionKey) return;
  pruneQuestionSessions(s);
  s.questionSessions.set(record.id, {
    sessionKey: record.sessionKey,
    expiresAtMs: record.expiresAtMs ?? Date.now() + QUESTION_DEFAULT_TTL_MS,
  });
}

// Session-bus payloads for approval lifecycle, discriminated by marker keys.
interface ApprovalRequestBusPayload {
  approvalRequest: ApprovalRequest;
}
interface ApprovalResolvedBusPayload {
  approvalResolved: { id: string; decision: string };
}
interface QuestionRequestedBusPayload {
  questionRequested: AgentQuestionRecord;
}
interface QuestionResolvedBusPayload {
  questionResolved: { id: string; status: string };
}

function attemptConnect(): Promise<GatewayStatus> {
  return new Promise((resolve) => {
    const s = store();
    const token = getGatewayToken();

    const client = new GatewayClient({
      url: GATEWAY_URL,
      token,
      role: "operator",
      scopes: SCOPES,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
      clientDisplayName: "Click-In",
      clientVersion: "0.1.0",
      platform: process.platform,
      minProtocol: 4,
      maxProtocol: 4,
      caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
      hostDeps: {
        loadOrCreateDeviceIdentity: device.loadOrCreateDeviceIdentity,
        signDevicePayload: device.signDevicePayload,
        publicKeyRawBase64UrlFromPem: device.publicKeyRawBase64UrlFromPem,
        loadDeviceAuthToken: device.loadDeviceAuthToken,
        storeDeviceAuthToken: device.storeDeviceAuthToken,
        clearDeviceAuthToken: device.clearDeviceAuthToken,
      },
      onEvent: (evt) => {
        // Raw event tap for diagnosing stream-shape mismatches (e.g. the
        // snapshot-vs-fragment `delta` semantics that differ across gateway
        // builds). Opt-in: AGENT_GATEWAY_DEBUG=1.
        if (process.env.AGENT_GATEWAY_DEBUG) {
          console.log(`[agent-gateway] ${evt.event}`, JSON.stringify(evt.payload)?.slice(0, 600));
        }
        if (evt.event === "chat") {
          const payload = evt.payload as ChatEventPayload;
          // Keyed by session, not runId: a tool-call turn spans multiple
          // runs under the same session (see subscribeToSession).
          if (payload?.sessionKey) s.events.emit(`session:${payload.sessionKey}`, payload);
          return;
        }
        if (evt.event === "agent") {
          const payload = evt.payload as AgentEventPayload;
          if (!payload?.sessionKey) return;
          const isToolLifecycle =
            payload.stream === "item" &&
            payload.data?.kind === "tool" &&
            (payload.data?.phase === "start" || payload.data?.phase === "end");
          // stream:"tool" 是同一批调用的"详情通道"：start 带 sanitize 后的
          // 完整参数 args，result 带结果与 isError（gateway 源码
          // handleToolExecutionStart/End 双流并发，toolCallId 一致）。
          // update（partialResult 进度噪声）不放行。
          const isToolDetail =
            payload.stream === "tool" &&
            (payload.data?.phase === "start" || payload.data?.phase === "result");
          // delta 或 text 任一存在都放行：实测两种形态并存（replace 快照
          // delta 为空串、增量事件带 delta），只认 delta 会把假设外的
          // 纯快照事件在门口静默扔掉——不报错、只是内容没了。
          const isAssistantText =
            payload.stream === "assistant" &&
            (typeof payload.data?.delta === "string" || typeof payload.data?.text === "string");
          if (isToolLifecycle || isToolDetail || isAssistantText) s.events.emit(`session:${payload.sessionKey}`, payload);
          return;
        }
        if (evt.event === "plugin.approval.requested") {
          const approval = extractApprovalRequest(evt.payload);
          if (!approval) return;
          // Sweep on every insert: an approval whose `resolved` broadcast was
          // lost (WS reconnect mid-approval, gateway restart) would otherwise
          // sit in this globalThis-cached store forever.
          prunePendingApprovals(s);
          s.pendingApprovals.set(approval.id, {
            sessionKey: approval.sessionKey,
            toolCallId: approval.toolCallId,
            ts: Date.now(),
          });
          if (approval.sessionKey) {
            // 无条件日志（每个 approval 一行，量极低）：审批链路的关键
            // 排障锚点——「广播到达且已路由」与「relay 是否转发」分属两行
            const listeners = s.events.listenerCount(`session:${approval.sessionKey}`);
            console.log(`[agent-gateway] approval ${approval.id} routed to ${approval.sessionKey} (listeners=${listeners})`);
            s.events.emit(`session:${approval.sessionKey}`, { approvalRequest: approval } satisfies ApprovalRequestBusPayload);
          } else {
            // Without a sessionKey the request can't be routed to a chat —
            // log loudly: an unrouted approval will time out and deny.
            console.error(`[agent-gateway] plugin approval ${approval.id} has no sessionKey — cannot surface in webchat`);
          }
          return;
        }
        if (evt.event === "plugin.approval.resolved") {
          const p = evt.payload as { id?: string; approvalId?: string; decision?: string } | undefined;
          const id = p?.id ?? p?.approvalId;
          if (!id) return;
          const pending = s.pendingApprovals.get(id);
          s.pendingApprovals.delete(id);
          if (pending?.sessionKey) {
            s.events.emit(`session:${pending.sessionKey}`, {
              approvalResolved: { id, decision: String(p?.decision ?? "unknown") },
            } satisfies ApprovalResolvedBusPayload);
          }
          return;
        }
        if (evt.event === "question.requested") {
          const record = extractQuestionRecord(evt.payload);
          if (!record) {
            // 形状不认识就静默丢弃 = 复刻"看不见的卡死 run"。大声记录，
            // 让协议形状漂移（gateway 升级换 payload）在日志里可见。
            console.error(
              "[agent-gateway] question.requested payload shape not recognized — question will be invisible:",
              JSON.stringify(evt.payload)?.slice(0, 400),
            );
            return;
          }
          if (!record.sessionKey) {
            // 无法路由到会话的问题会静默挂满 15 分钟然后过期——大声记录。
            console.error(`[agent-gateway] question ${record.id} has no sessionKey — cannot surface in webchat`);
            return;
          }
          rememberQuestionSession(s, record);
          s.events.emit(`session:${record.sessionKey}`, { questionRequested: record } satisfies QuestionRequestedBusPayload);
          return;
        }
        if (evt.event === "question.resolved") {
          // 该事件不带 sessionKey，路由只能靠 requested 时记下的映射（服务端
          // 重启后由 listSessionQuestions 补种）。回答可能来自任何 OpenClaw
          // 客户端，照单转发，不假设只有我们自己会回答。
          const p = evt.payload as { id?: string; status?: string } | undefined;
          if (!p?.id) return;
          const known = s.questionSessions.get(p.id);
          s.questionSessions.delete(p.id);
          if (known) {
            s.events.emit(`session:${known.sessionKey}`, {
              questionResolved: { id: p.id, status: String(p.status ?? "answered") },
            } satisfies QuestionResolvedBusPayload);
          }
        }
      },
      onHelloOk: () => {
        s.client = client;
        s.status = { state: "connected" };
        resolve(s.status);
      },
      onConnectError: (err) => {
        const pairing = readPairingConnectErrorDetails((err as { details?: unknown } | undefined)?.details);
        s.status = pairing
          ? { state: "pairing_required", requestId: pairing.requestId }
          : { state: "error", error: err?.message ?? "connect failed" };
        s.client = null;
        resolve(s.status);
      },
      onClose: () => {
        // Only fires for a post-hello drop; a pre-hello failure already
        // resolved via onConnectError. No background retry loop — the next
        // request-triggered connect() call reconnects from scratch.
        if (s.client === client) {
          s.client = null;
          s.status = { state: "disconnected" };
        }
      },
    });

    client.start();
  });
}

export async function connect(): Promise<GatewayStatus> {
  const s = store();
  if (!isGatewayConfigured()) return { state: "unconfigured" };
  if (s.status.state === "connected" && s.client) return s.status;
  if (s.connecting) return s.connecting;

  s.status = { state: "connecting" };
  s.connecting = attemptConnect().finally(() => {
    s.connecting = null;
  });
  return s.connecting;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}

interface HistoryMessage {
  role: string;
  content: unknown;
  // Only present on a "toolResult" entry — the tool that ran. There is no
  // "toolCall" block inside the assistant message itself; the call is only
  // visible via its result entry (confirmed live against 2026.7.2-beta.7).
  toolName?: string;
  toolCallId?: string;
}

// `content` on a real chat.history message is either a plain string (user
// messages) or an array of content blocks (assistant messages) — treating it
// as "always an array" silently drops every user message.
function blocksToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function requireConnectedClient(status: GatewayStatus): GatewayClient {
  const client = store().client;
  if (status.state !== "connected" || !client) {
    throw Object.assign(new Error(`Gateway not connected (state: ${status.state})`), {
      status: 409,
      gatewayStatus: status,
    });
  }
  return client;
}

export interface ChatStreamEvent {
  // "delta": incremental text fragment from the "agent"/"assistant" stream.
  // "replace": the same stream's full-content snapshot — the gateway emits
  // pre/post-tool narration as `replace: true` snapshots whose `delta` is
  // empty; dropping those loses every pre-tool sentence permanently.
  // "chat-delta": the "chat" stream's own delta (full text-so-far), used
  // only as fallback for plain replies with no tool calls.
  // "tool"/"tool-end": tool-call lifecycle, correlated by toolId.
  // "approval"/"approval-resolved": plugin approval gate lifecycle for a
  // write tool this session invoked — the /agent page is the team gateway's
  // only approval surface.
  // "question"/"question-resolved": ask_user 的 question.* 通道——问题挂着
  // 时 run 阻塞在 waitAnswer，卡片必须可见可答。
  // "tool-result": stream:"tool" 的 result 阶段——完整调用结果 + 是否失败，
  // 在 "tool-end"（item 流的 done 标记）之前到达，按 toolId 归并到同一气泡。
  type:
    | "delta"
    | "replace"
    | "chat-delta"
    | "final"
    | "aborted"
    | "error"
    | "tool"
    | "tool-result"
    | "tool-end"
    | "approval"
    | "approval-resolved"
    | "question"
    | "question-resolved";
  text: string;
  errorMessage?: string;
  toolName?: string;
  toolId?: string;
  /** "tool" 事件的调用参数（stream:"tool" start 的 args，可能缺席）。 */
  toolInput?: unknown;
  /** "tool-result" 事件的调用结果（MCP 结果对象，可能缺席）。 */
  toolResult?: unknown;
  toolIsError?: boolean;
  approval?: ApprovalRequest;
  approvalId?: string;
  decision?: string;
  question?: AgentQuestionRecord;
  questionId?: string;
  questionStatus?: string;
}

/**
 * Starts an agent run for a chat message; does not wait for it to finish.
 * `sessionKey` can be a brand-new key from createNewSessionKey() (the
 * session springs into existence on this first call) or an existing one —
 * a bare, unprefixed key works either way; the Gateway echoes back the
 * canonical `agent:<agentId>:`-prefixed form.
 */
export async function startChatRun(sessionKey: string, message: string): Promise<{ runId: string; sessionKey: string }> {
  const status = await connect();
  const client = requireConnectedClient(status);

  try {
    // 30s acceptance timeout: without it, a request written into a
    // half-open socket (gateway restarted, close event never fired) hangs
    // forever with zero bytes on the stream — Cloudflare then serves the
    // user a 524 after 100s (live-hit after a CD gateway restart).
    return await client.request<{ runId: string; sessionKey: string }>("agent", {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
    }, { timeoutMs: 30_000 });
  } catch (err) {
    // A timed-out acceptance (normally <1s) means the socket is almost
    // certainly dead-but-not-closed — tear it down explicitly (stop() closes
    // the WS and its listeners; just nulling the reference would leak the FD
    // until kernel reaping) so the NEXT attempt reconnects fresh. Guarded on
    // instance identity: if a concurrent caller already reconnected, don't
    // nuke the healthy new connection.
    try {
      client.stop();
    } catch {
      // already torn down
    }
    const s = store();
    if (s.client === client) {
      s.client = null;
      s.status = { state: "disconnected" };
      console.warn(
        "[agent-gateway] agent RPC failed — dropped connection for fresh reconnect:",
        err instanceof Error ? err.message : err,
      );
    }
    throw err;
  }
}

/**
 * Sends a message into a session that already has an active run — same
 * `agent` RPC as startChatRun: on 2026.7.x the default messages.queue
 * "steer" mode applies when a second `agent` call lands on a session with a
 * run in flight (confirmed live by MindWeave after upgrading past 5.22's
 * session-lock bug). markSteerPending tells the relay's already-open
 * connection to keep waiting for the steered run's reply too.
 */
export async function steerChatRun(sessionKey: string, message: string): Promise<{ runId: string; sessionKey: string }> {
  const result = await startChatRun(sessionKey, message);
  markSteerPending(result.sessionKey);
  return result;
}

/**
 * Cancels the active run for a session. `chat.abort` takes `{ sessionKey }`
 * and genuinely stops the run. Whether the gateway reliably delivers an
 * "aborted" chat event afterward is uncertain, so this synthesizes the
 * termination signal onto the session bus once the RPC confirms an abort —
 * harmless if redundant (the relay's done/closed guards make a duplicate
 * finish a no-op).
 */
export async function abortChatRun(sessionKey: string): Promise<boolean> {
  const status = await connect();
  const client = requireConnectedClient(status);
  const result = await client.request<{ ok?: boolean; aborted?: boolean }>("chat.abort", { sessionKey });
  if (!result.aborted) return false;
  store().events.emit(`session:${sessionKey}`, {
    sessionKey,
    state: "aborted",
    errorMessage: "已被用户中止",
  } satisfies ChatEventPayload);
  return true;
}

/**
 * Streams chat events for an entire session, not one run. A tool-call turn
 * spans multiple runIds under the same sessionKey — each model call that
 * pauses to invoke a tool ends its own run (a "final" with `yielded: true`),
 * then a fresh run picks up once the tool result comes back. Subscribing to
 * the session catches the whole turn regardless of how many runs it spans.
 */
export function subscribeToSession(sessionKey: string, onEvent: (event: ChatStreamEvent) => void): () => void {
  // Scoped to this one subscription so the same tool call isn't
  // re-announced if its "start" event is ever redelivered.
  const seenToolCalls = new Set<string>();
  const handler = (
    rawPayload:
      | ChatEventPayload
      | AgentEventPayload
      | ApprovalRequestBusPayload
      | ApprovalResolvedBusPayload
      | QuestionRequestedBusPayload
      | QuestionResolvedBusPayload,
  ) => {
    // Approval/question lifecycle payloads are discriminated by marker keys.
    if ("approvalRequest" in rawPayload) {
      onEvent({ type: "approval", text: "", approval: rawPayload.approvalRequest });
      return;
    }
    if ("approvalResolved" in rawPayload) {
      onEvent({
        type: "approval-resolved",
        text: "",
        approvalId: rawPayload.approvalResolved.id,
        decision: rawPayload.approvalResolved.decision,
      });
      return;
    }
    if ("questionRequested" in rawPayload) {
      onEvent({ type: "question", text: "", question: rawPayload.questionRequested });
      return;
    }
    if ("questionResolved" in rawPayload) {
      onEvent({
        type: "question-resolved",
        text: "",
        questionId: rawPayload.questionResolved.id,
        questionStatus: rawPayload.questionResolved.status,
      });
      return;
    }
    // "agent" events (tool start / assistant delta) vs "chat" events (state
    // machine) — "stream" only exists on the former, discriminating the union.
    if ("stream" in rawPayload) {
      const agentPayload = rawPayload as AgentEventPayload;
      if (agentPayload.stream === "assistant") {
        const delta = agentPayload.data?.delta;
        const text = agentPayload.data?.text;
        // `text` 是该段的权威累计值（实测 deltaLen=2/textLen=2 →
        // deltaLen=31/textLen=33 → deltaLen=4/textLen=37）——有它就走
        // replace 赋值，绝不累加：赋值对 Gateway 的重复投递天然幂等，模型
        // 真的重复输出时累计值自身会增长、不可能丢。delta 累加只是 text
        // 缺席时的兜底，且 relay 侧对"快照在场后的裸增量"另有忽略保护
        // （同段两种形态并存时 += 会双份，见 relay.ts agentSnapshotSeen）。
        if (typeof text === "string" && text) {
          onEvent({ type: "replace", text });
        } else if (typeof delta === "string" && delta) {
          onEvent({ type: "delta", text: delta });
        }
        return;
      }
      // stream:"tool" 详情通道：start（带 args）先于 item 流的 start 到达，
      // 所以气泡由这里创建、携带参数；item 流的 start 随后被 seenToolCalls
      // 去重。result 带完整结果，归并进已有气泡；done 标记仍由 item 流的
      // "end" 负责（两者都会来）。顺序不是猜的，是上游强制的：gateway 的
      // handleToolExecutionStart 在同一同步调用里先 emit tool 流再 emit
      // item 流，两者走同一条 websocket（单连接 FIFO 投递）——若这条契约
      // 破裂（item 先到），退化行为是气泡无参数，不炸。
      if (agentPayload.stream === "tool") {
        const toolId = agentPayload.data?.toolCallId ?? "";
        if (agentPayload.data?.phase === "result") {
          onEvent({
            type: "tool-result",
            text: "",
            toolId: toolId || undefined,
            toolResult: agentPayload.data?.result,
            toolIsError: agentPayload.data?.isError === true,
          });
          return;
        }
        if (toolId && !seenToolCalls.has(toolId)) {
          seenToolCalls.add(toolId);
          onEvent({
            type: "tool",
            text: "",
            toolName: agentPayload.data?.name || "工具",
            toolId,
            toolInput: agentPayload.data?.args,
          });
        }
        return;
      }
      const id = agentPayload.data?.toolCallId ?? agentPayload.data?.itemId ?? agentPayload.data?.name ?? "";
      if (agentPayload.data?.phase === "end") {
        onEvent({ type: "tool-end", text: "", toolId: id || undefined });
        return;
      }
      if (id && !seenToolCalls.has(id)) {
        seenToolCalls.add(id);
        onEvent({ type: "tool", text: "", toolName: agentPayload.data?.name || "工具", toolId: id });
      }
      return;
    }
    const payload = rawPayload as ChatEventPayload;
    if (payload.state === "delta") {
      // Fallback source only — see ChatStreamEvent comments.
      onEvent({ type: "chat-delta", text: blocksToText(payload.message?.content) });
    } else if (payload.state === "final") {
      // yielded+end_turn: this run paused for a tool, not really done — its
      // text is a duplicating blob once any tool call happened, so it's not
      // forwarded; the "agent"/"assistant" stream covers live text and a
      // later genuine final closes things out.
      if (payload.yielded === true && payload.stopReason === "end_turn") return;
      onEvent({ type: "final", text: blocksToText(payload.message?.content) });
    } else if (payload.state === "aborted" || payload.state === "error") {
      onEvent({ type: payload.state, text: "", errorMessage: payload.errorMessage });
    }
  };
  store().events.on(`session:${sessionKey}`, handler);
  return () => store().events.off(`session:${sessionKey}`, handler);
}

/**
 * Resolves once the run reaches a terminal state, throwing if it didn't
 * complete successfully — the chat event stream alone doesn't distinguish
 * "still running" from "failed and nothing more is coming".
 */
export async function waitForRunOutcome(runId: string): Promise<void> {
  const status = getStatus();
  const client = requireConnectedClient(status);
  const finished = await client.request<{ status?: string }>("agent.wait", { runId }, { timeoutMs: 120_000 });
  if (finished.status && finished.status !== "ok") {
    throw Object.assign(new Error(`Agent run did not complete (status: ${finished.status})`), { status: 502 });
  }
}

/**
 * Fallback for when a run resolved successfully but its "final" chat event
 * never arrived — pulls the authoritative text straight from chat.history.
 */
export async function fetchLatestAssistantText(sessionKey: string): Promise<string> {
  const client = requireConnectedClient(getStatus());
  const history = await client.request<{ messages: HistoryMessage[] }>("chat.history", { sessionKey, limit: 5 });
  for (let i = history.messages.length - 1; i >= 0; i--) {
    if (history.messages[i].role !== "assistant") continue;
    const text = blocksToText(history.messages[i].content);
    if (text) return text;
  }
  return "";
}

// chat.history gives each turn its own array entry — plain text, or a
// toolResult carrying the tool name — so tool calls can be reconstructed as
// their own entries the same way the live stream renders them.
export async function getChatHistory(sessionKey: string): Promise<ChatTranscriptEntry[]> {
  const status = await connect();
  if (status.state !== "connected") return [];
  const client = requireConnectedClient(status);

  const history = await client
    .request<{ messages: HistoryMessage[] }>("chat.history", { sessionKey, limit: 500 })
    .catch(() => ({ messages: [] as HistoryMessage[] }));

  const entries: ChatTranscriptEntry[] = [];
  for (const m of history.messages) {
    if (m.role === "user") {
      // 客户端附加的界面上下文信封只喂模型，不进展示——实时气泡本来就渲染
      // 用户原文，历史回放不剥就会露出一段用户没打过的字。
      const content = stripUiContext(blocksToText(m.content));
      if (content) entries.push({ role: "user", content });
      continue;
    }
    if (m.role === "toolResult") {
      if (m.toolName) {
        // 展示用途，截断保护：单条 wiki_read 结果可能是整篇文档。
        const result = blocksToText(m.content).slice(0, TOOL_PAYLOAD_MAX_CHARS);
        entries.push({
          role: "tool",
          name: m.toolName,
          id: m.toolCallId || undefined,
          ...(result ? { result } : {}),
        });
      }
      continue;
    }
    if (m.role !== "assistant") continue;

    const text = blocksToText(m.content);
    if (text) entries.push({ role: "assistant", content: text });
  }
  return entries;
}

interface SessionRow {
  key: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
}

// derivedTitle looks like "[Tue 2026-08-04 14:55 GMT+8] <first message>…" —
// strip the timestamp bracket; updatedAt already carries that information.
function cleanDerivedTitle(title: string | undefined): string | undefined {
  // 时间戳方括号在前、界面上下文信封在后（gateway 用首条用户消息派生标题，
  // 信封不剥的话每个会话都叫「<clickin-ui-context>…」）。
  return stripUiContext(title?.replace(/^\[[^\]]*\]\s*/, "") ?? "").trim() || undefined;
}

/** Lists ONLY the given user's sessions — the search filter is the per-user
 * namespace prefix, so other users' sessions are never even enumerated. */
export async function listChatSessions(userId: string): Promise<ChatSessionSummary[]> {
  const status = await connect();
  if (status.state !== "connected") return [];
  const client = requireConnectedClient(status);

  const result = await client.request<{ sessions: SessionRow[] }>("sessions.list", {
    search: `${SESSION_NAMESPACE}${userId}:`,
    includeDerivedTitles: true,
    includeLastMessage: true,
    limit: 100,
  });

  return result.sessions
    // OpenClaw's heartbeat runs attach a `:heartbeat` child session to the
    // agent's active session — keys like `agent:main:clickin:chat:...:heartbeat`
    // match the namespace search but are just HEARTBEAT_OK noise.
    .filter((row) => !row.key.endsWith(":heartbeat"))
    // Defense in depth: the search filter should already scope to this user,
    // but ownership is re-checked per row anyway.
    .filter((row) => sessionKeyOwnedBy(row.key, userId))
    .map((row) => ({
      key: row.key,
      title: row.label || cleanDerivedTitle(row.derivedTitle) || "新对话",
      lastMessagePreview: row.lastMessagePreview && stripUiContext(row.lastMessagePreview),
      updatedAt: row.updatedAt ?? undefined,
      status: row.status,
    }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function renameChatSession(sessionKey: string, label: string): Promise<void> {
  const status = await connect();
  const client = requireConnectedClient(status);
  // sessions.patch/sessions.delete use `key`, not `sessionKey` like every
  // other session method (confirmed against the actual protocol schema).
  await client.request("sessions.patch", { key: sessionKey, label });
}

export async function deleteChatSession(sessionKey: string): Promise<void> {
  const status = await connect();
  const client = requireConnectedClient(status);
  await client.request("sessions.delete", { key: sessionKey });
}

// ─── Plugin approvals ────────────────────────────────────────────────────────

const APPROVAL_TTL_MS = 600_000; // gateway hard-caps approval timeouts at 10min

/** Evicts pending-approval entries past the gateway's own approval cap —
 * called on every insert and every lookup, so lost `resolved` broadcasts
 * (or unrouted entries with no sessionKey) can't accumulate. */
function prunePendingApprovals(s: GatewayStore): void {
  const now = Date.now();
  for (const [id, entry] of s.pendingApprovals) {
    if (now - entry.ts > APPROVAL_TTL_MS) s.pendingApprovals.delete(id);
  }
}

/** Owning sessionKey for a pending approval (for the resolve API's ownership
 * check). Expired entries are treated as unknown. */
export function getPendingApprovalSession(approvalId: string): string | undefined {
  const s = store();
  prunePendingApprovals(s);
  return s.pendingApprovals.get(approvalId)?.sessionKey;
}

const DENY_REASON_TTL_MS = 600_000; // 与 approval 生命周期上限一致

/** 按 approval id 暂存拒绝理由（键转为 toolCallId）。必须在 resolve RPC
 * **之前**调用——保证插件的 tool_result_persist 触发时理由已可取。
 * 返回 false 表示该 approval 没有 toolCallId 可关联（理由无处安放）。 */
export function storeDenyReason(approvalId: string, reason: string): boolean {
  const s = store();
  const toolCallId = s.pendingApprovals.get(approvalId)?.toolCallId;
  if (!toolCallId) return false;
  const now = Date.now();
  for (const [k, v] of s.denyReasons) {
    if (now - v.ts > DENY_REASON_TTL_MS) s.denyReasons.delete(k);
  }
  s.denyReasons.set(toolCallId, { reason, ts: now });
  return true;
}

/** 一次性取走某个工具调用的拒绝理由（供 MCP 同进程端点转交插件）。
 * 读侧同样全量清扫：某条理由若从未被取走（插件 fetch 失败 / persist
 * 未触发），不能指望下一次 store 才回收——这是 globalThis 常驻 map。 */
export function takeDenyReason(toolCallId: string): string | undefined {
  const s = store();
  const now = Date.now();
  for (const [k, v] of s.denyReasons) {
    if (now - v.ts > DENY_REASON_TTL_MS) s.denyReasons.delete(k);
  }
  const entry = s.denyReasons.get(toolCallId);
  if (!entry) return undefined;
  s.denyReasons.delete(toolCallId);
  return entry.reason;
}

/**
 * Resolves a pending plugin approval via `plugin.approval.resolve` —
 * live-validated against the production gateway (2026.7.1-2): the protocol
 * doc's kind-agnostic `approval.resolve` does NOT exist there ("unknown
 * method"), while this one works with `{ id, decision }`.
 */
export async function resolveApproval(approvalId: string, decision: "allow-once" | "allow-always" | "deny"): Promise<void> {
  const status = await connect();
  const client = requireConnectedClient(status);
  await client.request("plugin.approval.resolve", { id: approvalId, decision });
}

// ─── Session run state（权威来源）───────────────────────────────────────────

export type SessionRunState = "running" | "not-running" | "unknown";

/**
 * 权威回答"这个会话还在跑吗"。事件流的静默不能回答这个问题——tool call
 * 期间完全静默，和 run 已结束在流上长得一模一样（MindWeave《Agent 流式
 * 中继：静默不等于结束》）。relay 的计时器到点后来这里问一次，而不是把
 * 静默当作结束的判决。
 *
 * "unknown" = 瞬时查询失败（RPC 错误、网关重连中），按"还在跑"处理但由
 * 调用方限次；"not-running" 包括会话不存在与 status 非 running。这里主动
 * connect()：若 WS 曾断开，这一步顺带把事件订阅的底层连接也救活。
 */
export async function fetchSessionRunState(sessionKey: string): Promise<SessionRunState> {
  let status: GatewayStatus;
  try {
    status = await connect();
  } catch {
    return "unknown";
  }
  // 未配置是永久状态，不是瞬时故障——按"没在跑"收尾，避免无限等待。
  if (status.state === "unconfigured") return "not-running";
  try {
    const client = requireConnectedClient(status);
    const result = await client.request<{ sessions: SessionRow[] }>(
      "sessions.list",
      { search: sessionKey, limit: 10 },
      { timeoutMs: 10_000 },
    );
    // canonical vs raw：行 key 是 canonical 形式，查询 key 可能是 raw——
    // 必须后缀容错比较，=== 会静默匹配不到任何东西。
    const row = result.sessions.find((r) => r.key === sessionKey || r.key.endsWith(`:${sessionKey}`));
    if (!row) return "not-running";
    return row.status === "running" ? "running" : "not-running";
  } catch {
    return "unknown";
  }
}

// ─── ask_user questions ─────────────────────────────────────────────────────

/** 某会话的全部待答问题（question.list 无过滤参数，只能客户端自己筛，
 * 同样必须后缀容错比较 session key）。顺带补种 id→sessionKey 路由映射：
 * 服务端重启后内存映射为空，重启前发出的问题其 resolved 事件会无处路由。
 *
 * 活体探针实测（2026-08-21，scripts/gateway-probe.ts）：生产 gateway
 * 2026.7.1-2 尚无 question.* 协议（unknown method），ask_user 也不存在——
 * 该版本上这整套集成是前向兼容的休眠代码，unknown method 按"没有待答
 * 问题"处理，不能让每次重开 running 会话都对着老 gateway 报错。gateway
 * 升级后用 gateway-probe --questions / --question-roundtrip 复验信封形状。 */
export async function listSessionQuestions(sessionKey: string): Promise<AgentQuestionRecord[]> {
  const status = await connect();
  if (status.state !== "connected") return [];
  const client = requireConnectedClient(status);
  let result: { questions?: unknown[] };
  try {
    result = await client.request<{ questions?: unknown[] }>("question.list", {});
  } catch (err) {
    if (err instanceof Error && /unknown method/i.test(err.message)) return [];
    throw err;
  }
  const records = (result.questions ?? [])
    .map(extractQuestionRecord)
    .filter((r): r is AgentQuestionRecord => r !== null)
    .filter((r) => r.sessionKey === sessionKey || r.sessionKey?.endsWith(`:${sessionKey}`));
  const s = store();
  for (const r of records) rememberQuestionSession(s, r);
  return records.filter((r) => r.status === "pending");
}

/** 问题归属的 sessionKey（回答 API 的所有权检查用）。内存映射未命中时退到
 * question.get——重启后映射为空不能当"问题不存在"。 */
export async function getQuestionSessionKey(questionId: string): Promise<string | undefined> {
  const s = store();
  pruneQuestionSessions(s);
  const known = s.questionSessions.get(questionId);
  if (known) return known.sessionKey;
  const status = await connect();
  const client = requireConnectedClient(status);
  const result = await client.request<unknown>("question.get", { id: questionId }).catch(() => null);
  const record = extractQuestionRecord(result);
  if (record) rememberQuestionSession(s, record);
  return record?.sessionKey;
}

/** 回答或取消一个待答问题。回答格式：answers 双层包裹、值恒为数组（单选也
 * 是）；重复 resolve 会被 Gateway 拒绝——多客户端竞态属正常，原样抛给调用方。 */
export async function resolveQuestion(
  questionId: string,
  outcome: { answers: Record<string, string[]> } | { cancel: true },
): Promise<void> {
  const status = await connect();
  const client = requireConnectedClient(status);
  if ("cancel" in outcome) {
    await client.request("question.resolve", { id: questionId, cancel: true });
    return;
  }
  await client.request("question.resolve", { id: questionId, answers: { answers: outcome.answers } });
}
