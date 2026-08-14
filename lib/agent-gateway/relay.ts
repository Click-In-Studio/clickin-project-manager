import type { NextRequest } from "next/server";
import { consumeExpectedSteerFinal, fetchLatestAssistantText, subscribeToSession, waitForRunOutcome } from "./client";
import type { ChatStreamEvent } from "./client";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartRunResult {
  runId: string;
  sessionKey: string;
}

/**
 * Streams newline-delimited JSON chat events for a session. If `startRun`
 * is given, it kicks off a brand-new agent run first (the "send a message"
 * case); if omitted, this just attaches to whatever's already streaming for
 * `sessionKey` (reopening a session that's mid-reply). Both share this
 * relay because subscribeToSession is session-scoped, not tied to whichever
 * request originated the run — any number of listeners can watch the same
 * session's live events.
 *
 * Known limitation of the attach-only path: there's no way to fetch
 * "whatever text already streamed" for an in-progress run, so a freshly
 * attached watcher only sees text from the moment it attached onward;
 * chat.history fills in the complete text once the run finishes.
 */
export function createChatStreamResponse(
  req: NextRequest,
  sessionKey: string,
  options: { startRun?: () => Promise<StartRunResult>; overallTimeoutMs?: number } = {}
): Response {
  const { startRun, overallTimeoutMs = 180_000 } = options;
  const POLL_INTERVAL_MS = 1000;

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      function send(obj: unknown) {
        if (closed) return;
        // SSE 帧格式（data: <json>\n\n）而非裸 NDJSON：Cloudflare 与 nginx
        // 都对 text/event-stream 特殊豁免（不压缩、不缓冲）。裸 ndjson 会被
        // CF 压缩器攒缓冲——小帧（tool/approval，几百字节）永远到不了浏览
        // 器，实锤表现：relay 已写入 approval 帧而卡片不渲染、思考泡泡从未
        // 出现（连响应头都被攒着）。剧本/cue 的 SSE 同链路一直实时，即证。
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      }
      function finish(obj?: unknown) {
        if (closed) return;
        // send() no-ops once closed is true, so the terminal payload has to
        // go out first — flipping closed early would silently drop every
        // final/aborted/error event before it reached the client.
        if (obj) send(obj);
        closed = true;
        unsubscribe?.();
        controller.close();
      }

      req.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe?.();
      });

      // Two possible text sources with SEPARATE buffers, never mixed: the
      // "chat" stream's own delta/final (full-text-so-far, fine for a plain
      // reply with no tool calls) and the "agent"/"assistant" stream
      // (required once a tool call happens — the "chat" stream's text
      // starts duplicating across the tool-call boundary). The first
      // tool-call or "agent"/"assistant" event flips usingAgentStream
      // permanently for this request; chat-delta is ignored from then on.
      // Separate buffers matter: both sources can be live at once for a
      // plain reply, and letting an agent-stream fragment append onto text
      // that came from a chat-delta snapshot duplicates content.
      let usingAgentStream = false;
      let agentText = "";
      let chatText = "";
      const liveText = () => (usingAgentStream ? agentText : chatText);
      let sessionDone = false;
      let deadline = Date.now() + overallTimeoutMs;
      // An approval gate pauses the run gateway-side (up to its own timeout)
      // and the continued run needs time of its own afterward — push this
      // stream's deadline out so it doesn't cut the exchange short.
      const extendDeadline = () => {
        deadline = Date.now() + overallTimeoutMs;
      };
      // steerChatRun() registers pending steers under the *canonical*
      // sessionKey the Gateway echoes back — for a brand-new session that
      // differs from the pre-canonical key this request arrived with, so
      // consumeExpectedSteerFinal has to check under the canonical key.
      let canonicalSessionKey = sessionKey;

      function handleSessionEvent(evt: ChatStreamEvent) {
        if (evt.type === "approval") {
          // A write tool hit its confirmation gate — surface the card; the
          // run stays paused gateway-side until resolved (or times out to
          // deny), so extend this stream's own deadline to outlive the
          // approval window plus the continued run.
          extendDeadline();
          // TODO(卡片排障): 临时探针，配合 client.ts 的 routed 行三段定位
          // 断点（路由/转发/前端）；谜底揭晓后移除本行
          console.log(`[agent-gateway] relay forwarding approval ${evt.approval?.id} (closed=${closed})`);
          send({ type: "approval", approval: evt.approval });
          return;
        }
        if (evt.type === "approval-resolved") {
          // The continued (or denied) run needs fresh time after the gate.
          extendDeadline();
          send({ type: "approval-resolved", id: evt.approvalId, decision: evt.decision });
          return;
        }
        if (evt.type === "tool-end") {
          send({ type: "tool-end", id: evt.toolId });
          return;
        }
        if (evt.type === "tool") {
          // A tool call is a segment boundary: pre-tool text has already
          // arrived (via "replace" snapshots), and whatever follows belongs
          // to a fresh segment.
          usingAgentStream = true;
          agentText = "";
          send({ type: "tool", name: evt.toolName, id: evt.toolId });
          return;
        }
        if (evt.type === "delta") {
          usingAgentStream = true;
          agentText += evt.text;
          send({ type: "delta", text: agentText });
          return;
        }
        if (evt.type === "replace") {
          // Cumulative snapshot — authoritative for the current segment,
          // replaces whatever accumulated so far.
          usingAgentStream = true;
          agentText = evt.text;
          send({ type: "delta", text: agentText });
          return;
        }
        if (evt.type === "chat-delta") {
          if (usingAgentStream) return;
          chatText = evt.text;
          send({ type: "delta", text: chatText });
          return;
        }
        // final/aborted/error mark the session's work done by default — but
        // if a message was steered into this session, a genuine terminal
        // event for the run that triggered it isn't the end of the whole
        // exchange, just one of (at least) two runs this connection covers.
        if (evt.type === "final") {
          if (consumeExpectedSteerFinal(canonicalSessionKey)) {
            if (!usingAgentStream) chatText = evt.text;
            send({ type: "delta", text: liveText() });
            return;
          }
          sessionDone = true;
          finish({ type: "final", text: usingAgentStream ? agentText : evt.text });
          return;
        }
        if (evt.type === "aborted") {
          if (consumeExpectedSteerFinal(canonicalSessionKey)) {
            if (!usingAgentStream) chatText = evt.text;
            send({ type: "delta", text: liveText() });
            return;
          }
          sessionDone = true;
          finish({ type: "aborted", text: usingAgentStream ? agentText : evt.text });
          return;
        }
        if (consumeExpectedSteerFinal(canonicalSessionKey)) return;
        // error: genuinely terminal.
        sessionDone = true;
        finish({ type: "error", error: evt.errorMessage || "Agent run did not complete" });
      }

      try {
        // Subscribe *before* starting the run — starting it can produce
        // events almost immediately, and an EventEmitter never replays what
        // it already emitted to a listener that shows up late.
        unsubscribe = subscribeToSession(sessionKey, handleSessionEvent);

        // First byte goes out BEFORE startRun: if the gateway RPC hangs
        // (half-open socket), the client/watchdog/Cloudflare see a live
        // stream instead of 100s of dead silence ending in a CF 524.
        send({ type: "ping" });

        const started = startRun ? await startRun() : { runId: null as string | null, sessionKey };

        // Brand-new session: the canonical key echoed back can differ from
        // the pre-canonical key this request was made with. Subscribe under
        // that one too — redundant but harmless when they're already equal.
        if (started.sessionKey !== sessionKey) {
          canonicalSessionKey = started.sessionKey;
          const secondUnsubscribe = subscribeToSession(started.sessionKey, handleSessionEvent);
          const firstUnsubscribe = unsubscribe;
          unsubscribe = () => {
            firstUnsubscribe?.();
            secondUnsubscribe();
          };
        }

        // Tell the client the canonical key so its NEXT send passes it
        // directly — when the client sends a bare key, this relay only
        // subscribes to the canonical form after the RPC echo above, and
        // any events emitted before that frame arrives are lost forever
        // (EventEmitter has no replay). Live-hit: a fast tool call's
        // start + approval events raced the echo and the card never showed.
        if (started.runId) send({ type: "session", key: started.sessionKey });

        // Fire-and-forget: agent.wait only tracks the FIRST segment's runId,
        // and a tool-call turn spans multiple runIds — so its resolution
        // can't gate finishing the stream. The subscription is the sole
        // source of truth for when the exchange is done; this just surfaces
        // otherwise-silent RPC failures.
        if (started.runId) waitForRunOutcome(started.runId).catch(() => {});

        // Heartbeat lines let the client distinguish "quiet but alive" (long
        // model call, approval gate waiting on a human) from a dead
        // connection (server restarted mid-stream) — without one, a client
        // watchdog can't exist and a severed stream hangs its reader forever.
        let lastPing = Date.now();
        while (!sessionDone && !closed && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          if (Date.now() - lastPing >= 15_000) {
            lastPing = Date.now();
            send({ type: "ping" });
          }
        }
        if (!sessionDone && !closed) {
          // fallback: true 让客户端知道这个 final 来自 chat.history 兜底
          // （可能是上一轮已渲染的旧文本）——只有带此标记的 final 才做
          // 与上一条气泡的去重，正常回复即使文本相同也不会被误吞。
          const text = await fetchLatestAssistantText(started.sessionKey);
          finish({ type: "final", text: text || liveText(), fallback: true });
        }
      } catch (err) {
        finish({ type: "error", error: err instanceof Error ? err.message : "Agent run failed" });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
