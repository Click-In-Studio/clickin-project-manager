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
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
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

      // Two possible text sources, never mixed: the "chat" stream's own
      // delta/final (full-text-so-far, fine for a plain reply with no tool
      // calls) or the "agent"/"assistant" stream's genuinely incremental
      // delta (required once a tool call happens — the "chat" stream's text
      // starts duplicating across the tool-call boundary). The first
      // tool-call or "agent"/"assistant" event flips usingAgentStream
      // permanently for this request; chat-delta is ignored from then on.
      let usingAgentStream = false;
      let currentText = "";
      let sessionDone = false;
      // steerChatRun() registers pending steers under the *canonical*
      // sessionKey the Gateway echoes back — for a brand-new session that
      // differs from the pre-canonical key this request arrived with, so
      // consumeExpectedSteerFinal has to check under the canonical key.
      let canonicalSessionKey = sessionKey;

      function handleSessionEvent(evt: ChatStreamEvent) {
        if (evt.type === "tool-end") {
          send({ type: "tool-end", id: evt.toolId });
          return;
        }
        if (evt.type === "tool") {
          // A tool call is a segment boundary: pre-tool text has already
          // arrived (via "replace" snapshots), and whatever follows belongs
          // to a fresh segment.
          usingAgentStream = true;
          currentText = "";
          send({ type: "tool", name: evt.toolName, id: evt.toolId });
          return;
        }
        if (evt.type === "delta") {
          usingAgentStream = true;
          currentText += evt.text;
          send({ type: "delta", text: currentText });
          return;
        }
        if (evt.type === "replace") {
          // Full-content snapshot (commentary segment) — authoritative for
          // the current segment, replaces whatever accumulated so far.
          usingAgentStream = true;
          currentText = evt.text;
          send({ type: "delta", text: currentText });
          return;
        }
        if (evt.type === "chat-delta") {
          if (usingAgentStream) return;
          currentText = evt.text;
          send({ type: "delta", text: currentText });
          return;
        }
        // final/aborted/error mark the session's work done by default — but
        // if a message was steered into this session, a genuine terminal
        // event for the run that triggered it isn't the end of the whole
        // exchange, just one of (at least) two runs this connection covers.
        if (evt.type === "final") {
          if (consumeExpectedSteerFinal(canonicalSessionKey)) {
            if (!usingAgentStream) currentText = evt.text;
            send({ type: "delta", text: currentText });
            return;
          }
          sessionDone = true;
          finish({ type: "final", text: usingAgentStream ? currentText : evt.text });
          return;
        }
        if (evt.type === "aborted") {
          if (consumeExpectedSteerFinal(canonicalSessionKey)) {
            if (!usingAgentStream) currentText = evt.text;
            send({ type: "delta", text: currentText });
            return;
          }
          sessionDone = true;
          finish({ type: "aborted", text: usingAgentStream ? currentText : evt.text });
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

        // Fire-and-forget: agent.wait only tracks the FIRST segment's runId,
        // and a tool-call turn spans multiple runIds — so its resolution
        // can't gate finishing the stream. The subscription is the sole
        // source of truth for when the exchange is done; this just surfaces
        // otherwise-silent RPC failures.
        if (started.runId) waitForRunOutcome(started.runId).catch(() => {});

        const deadline = Date.now() + overallTimeoutMs;
        while (!sessionDone && !closed && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
        }
        if (!sessionDone && !closed) {
          const text = await fetchLatestAssistantText(started.sessionKey);
          finish({ type: "final", text: text || currentText });
        }
      } catch (err) {
        finish({ type: "error", error: err instanceof Error ? err.message : "Agent run failed" });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
