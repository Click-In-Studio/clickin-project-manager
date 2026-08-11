import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { GatewayClient } from "@openclaw/gateway-client";
import { readPairingConnectErrorDetails } from "@openclaw/gateway-protocol/connect-error-details";
import { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "@openclaw/gateway-protocol/client-info";
import { GATEWAY_URL, getGatewayToken, isGatewayConfigured } from "./config";
import * as device from "./device";
import type { ChatSessionSummary, ChatTranscriptEntry, GatewayStatus } from "./types";

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

export function createNewSessionKey(userId: string): string {
  return `${SESSION_NAMESPACE}${userId}:${crypto.randomUUID()}`;
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
  pendingApprovals: Map<string, { sessionKey?: string; ts: number }>;
  // Timestamps of steers whose extra "final" a session's relay connection
  // should still wait for before closing — appended by steerChatRun(),
  // consumed by the relay. A steered message is a genuinely separate run
  // from the Gateway's perspective, so without this the relay would close
  // on the first run's own final and never see the steered run's reply
  // live. Entries expire (see STEER_EXPECTATION_TTL_MS): if the relay that
  // registered one died before its final arrived, a permanent counter would
  // make the session's NEXT stream swallow a genuine final and stall to its
  // timeout fallback.
  pendingSteers: Map<string, number[]>;
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
      pendingSteers: new Map(),
    };
  }
  return globalThis.__clickinAgentGateway;
}

// Matches the relay's overallTimeoutMs: an expectation older than this
// belongs to an exchange whose relay has certainly stopped waiting.
const STEER_EXPECTATION_TTL_MS = 180_000;

export function markSteerPending(sessionKey: string): void {
  const s = store();
  const list = s.pendingSteers.get(sessionKey) ?? [];
  list.push(Date.now());
  s.pendingSteers.set(sessionKey, list);
}

/** Called by the relay on every genuine (non-yielded) final — returns true
 * if there's still at least one more steered run it should keep waiting
 * for, having consumed one unit of that expectation. Stale expectations
 * (whose relay died before the final arrived) are pruned, not consumed. */
export function consumeExpectedSteerFinal(sessionKey: string): boolean {
  const s = store();
  const now = Date.now();
  const fresh = (s.pendingSteers.get(sessionKey) ?? []).filter((t) => now - t < STEER_EXPECTATION_TTL_MS);
  if (fresh.length === 0) {
    s.pendingSteers.delete(sessionKey);
    return false;
  }
  fresh.shift();
  if (fresh.length === 0) s.pendingSteers.delete(sessionKey);
  else s.pendingSteers.set(sessionKey, fresh);
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
  return {
    id,
    title: String(pick("title") ?? "工具调用确认"),
    description: String(pick("description") ?? ""),
    severity: severity === "info" || severity === "critical" ? severity : "warning",
    allowedDecisions: Array.isArray(allowed) && allowed.length > 0
      ? allowed.map(String)
      : ["allow-once", "allow-always", "deny"],
    sessionKey: typeof sessionKey === "string" ? sessionKey : undefined,
  };
}

// Session-bus payloads for approval lifecycle, discriminated by marker keys.
interface ApprovalRequestBusPayload {
  approvalRequest: ApprovalRequest;
}
interface ApprovalResolvedBusPayload {
  approvalResolved: { id: string; decision: string };
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
          const isAssistantDelta = payload.stream === "assistant" && typeof payload.data?.delta === "string";
          if (isToolLifecycle || isAssistantDelta) s.events.emit(`session:${payload.sessionKey}`, payload);
          return;
        }
        if (evt.event === "plugin.approval.requested") {
          const approval = extractApprovalRequest(evt.payload);
          if (!approval) return;
          // Sweep on every insert: an approval whose `resolved` broadcast was
          // lost (WS reconnect mid-approval, gateway restart) would otherwise
          // sit in this globalThis-cached store forever.
          prunePendingApprovals(s);
          s.pendingApprovals.set(approval.id, { sessionKey: approval.sessionKey, ts: Date.now() });
          if (approval.sessionKey) {
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
  type: "delta" | "replace" | "chat-delta" | "final" | "aborted" | "error" | "tool" | "tool-end" | "approval" | "approval-resolved";
  text: string;
  errorMessage?: string;
  toolName?: string;
  toolId?: string;
  approval?: ApprovalRequest;
  approvalId?: string;
  decision?: string;
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

  return client.request<{ runId: string; sessionKey: string }>("agent", {
    sessionKey,
    message,
    idempotencyKey: crypto.randomUUID(),
  });
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
  const handler = (rawPayload: ChatEventPayload | AgentEventPayload | ApprovalRequestBusPayload | ApprovalResolvedBusPayload) => {
    // Approval lifecycle payloads are discriminated by their marker keys.
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
    // "agent" events (tool start / assistant delta) vs "chat" events (state
    // machine) — "stream" only exists on the former, discriminating the union.
    if ("stream" in rawPayload) {
      const agentPayload = rawPayload as AgentEventPayload;
      if (agentPayload.stream === "assistant") {
        const delta = agentPayload.data?.delta;
        const text = agentPayload.data?.text;
        // `text` is the authoritative cumulative text for the current
        // segment — prefer it as a replace-style snapshot whenever present.
        // Do NOT accumulate `delta` when `text` exists: some gateway builds
        // emit snapshot events whose `delta` carries the full text rather
        // than an increment (observed live: treating those as fragments
        // duplicates the whole reply once per snapshot). `delta`
        // accumulation is only the fallback for events with no `text`.
        if (typeof text === "string" && text) {
          onEvent({ type: "replace", text });
        } else if (typeof delta === "string" && delta) {
          onEvent({ type: "delta", text: delta });
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
      const content = blocksToText(m.content);
      if (content) entries.push({ role: "user", content });
      continue;
    }
    if (m.role === "toolResult") {
      if (m.toolName) entries.push({ role: "tool", name: m.toolName, id: m.toolCallId || undefined });
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
  return title?.replace(/^\[[^\]]*\]\s*/, "").trim() || undefined;
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
      lastMessagePreview: row.lastMessagePreview,
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
