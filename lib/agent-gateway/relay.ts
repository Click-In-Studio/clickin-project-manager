import type { NextRequest } from "next/server";
import {
  createSteerOwner,
  fetchLatestAssistantText,
  fetchSessionRunState,
  subscribeToSession,
  waitForRunOutcome,
} from "./client";
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
 * 静默不等于结束（MindWeave 同名调研）：tool call 期间事件流完全静默，和
 * run 已结束在流上不可区分，所以这里的计时器语义是"提问"而非"判决"——
 * 安静 quietTimeoutMs 后去问权威来源（sessions.list 的 status）"还在跑
 * 吗"，回答"是"就继续等，只有回答"否"才走 chat.history 兜底收尾；瞬时
 * 查询失败按"还在跑"处理（限次），不能成为砍掉活着的回复的理由。
 *
 * Known limitation of the attach-only path: there's no way to fetch
 * "whatever text already streamed" for an in-progress run, so a freshly
 * attached watcher only sees text from the moment it attached onward;
 * chat.history fills in the complete text once the run finishes.
 */
export function createChatStreamResponse(
  req: NextRequest,
  sessionKey: string,
  options: { startRun?: () => Promise<StartRunResult>; quietTimeoutMs?: number } = {}
): Response {
  const { startRun, quietTimeoutMs = 180_000 } = options;
  const POLL_INTERVAL_MS = 1000;
  // 权威查询失败（unknown）后的重试间隔与限次：网关短暂重连不该断流，但
  // 持续查不到也不能让连接永远挂着。
  const UNKNOWN_RETRY_MS = 15_000;
  const MAX_UNKNOWN_STREAK = 3;

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  // 本连接持有的 steer 期望——连接关闭（正常收尾和客户端中断都算）随之
  // 释放，没有孤儿，也就不需要 TTL 去猜谁是孤儿。
  const steerOwner = createSteerOwner(sessionKey);

  const stream = new ReadableStream({
    async start(controller) {
      // 幂等去重：gateway 会在一秒内重发同一句话的全量快照 30+ 次，每次
      // 下发对前端都可能是一次完整的 markdown 重渲染。与上次下发内容完全
      // 相同的 delta 帧不再发。
      let lastSentDelta: string | null = null;
      function send(obj: unknown) {
        if (closed) return;
        // SSE 帧格式（data: <json>\n\n）而非裸 NDJSON：Cloudflare 与 nginx
        // 都对 text/event-stream 特殊豁免（不压缩、不缓冲）。裸 ndjson 会被
        // CF 压缩器攒缓冲——小帧（tool/approval，几百字节）永远到不了浏览
        // 器，实锤表现：relay 已写入 approval 帧而卡片不渲染、思考泡泡从未
        // 出现（连响应头都被攒着）。剧本/cue 的 SSE 同链路一直实时，即证。
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      }
      function sendDelta(text: string) {
        if (text === lastSentDelta) return;
        lastSentDelta = text;
        send({ type: "delta", text });
      }
      function finish(obj?: unknown) {
        if (closed) return;
        // send() no-ops once closed is true, so the terminal payload has to
        // go out first — flipping closed early would silently drop every
        // final/aborted/error event before it reached the client.
        if (obj) send(obj);
        closed = true;
        unsubscribe?.();
        steerOwner.release();
        controller.close();
      }

      const onClientGone = () => {
        closed = true;
        unsubscribe?.();
        steerOwner.release();
      };
      req.signal.addEventListener("abort", onClientGone);
      // 已 aborted 的 signal 上 addEventListener 永远不会回调——请求在
      // start() 运行前就断掉时必须显式收尾，否则这条连接的循环会一直跑
      // 到权威说结束，steer owner 也随之泄漏。
      if (req.signal.aborted) onClientGone();

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
      // 段内一旦收到过累计快照（replace，text 为权威累计值），后续的裸增量
      // （delta-only）一律忽略：Gateway 实测会把同一段文本以两种形态各发一
      // 遍（replace:true/text:X 与 delta:X），对后者做 += 就是双份文本；而
      // 协议里每个 assistant 事件都带累计 text，真正的新增内容必然会以下
      // 一个快照到达，忽略增量不会丢字。从未见过快照的构建（纯增量形态）
      // 不受影响，照常累加。这是"以累计值赋值，而不是识别重复再丢弃"——
      // 后者分不清 Gateway 重述和模型真的又说了一遍同样的话。
      let agentSnapshotSeen = false;
      let chatText = "";
      const liveText = () => (usingAgentStream ? agentText : chatText);
      let sessionDone = false;
      // "安静计时器"：任何事件到达都重置。到点≠结束，只是该去问权威来源了。
      let deadline = Date.now() + quietTimeoutMs;
      const extendDeadline = () => {
        deadline = Date.now() + quietTimeoutMs;
      };
      // steerChatRun() registers pending steers under the *canonical*
      // sessionKey the Gateway echoes back — for a brand-new session that
      // differs from the pre-canonical key this request arrived with, so
      // the steer owner has to be attached under the canonical key too.
      let canonicalSessionKey = sessionKey;

      function handleSessionEvent(evt: ChatStreamEvent) {
        // 每个事件都是"还活着"的证据——安静计时器随之重置。
        extendDeadline();
        if (evt.type === "approval") {
          // A write tool hit its confirmation gate — surface the card; the
          // run stays paused gateway-side until resolved (or times out to
          // deny).
          // TODO(卡片排障): 临时探针，配合 client.ts 的 routed 行三段定位
          // 断点（路由/转发/前端）；谜底揭晓后移除本行
          console.log(`[agent-gateway] relay forwarding approval ${evt.approval?.id} (closed=${closed})`);
          send({ type: "approval", approval: evt.approval });
          return;
        }
        if (evt.type === "approval-resolved") {
          send({ type: "approval-resolved", id: evt.approvalId, decision: evt.decision });
          return;
        }
        if (evt.type === "question") {
          // ask_user 的问题卡片。回答之前 run 阻塞在 question.waitAnswer、
          // 会话状态保持 running——安静计时器到点后的权威查询自然会续命，
          // 直到有人回答或问题过期，这里无需再为它单独延时。
          send({ type: "question", question: evt.question });
          return;
        }
        if (evt.type === "question-resolved") {
          send({ type: "question-resolved", id: evt.questionId, status: evt.questionStatus });
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
          agentSnapshotSeen = false;
          lastSentDelta = null;
          send({ type: "tool", name: evt.toolName, id: evt.toolId });
          return;
        }
        if (evt.type === "delta") {
          usingAgentStream = true;
          // 快照在场时增量必是重述（见 agentSnapshotSeen 声明处）。
          if (agentSnapshotSeen) return;
          agentText += evt.text;
          sendDelta(agentText);
          return;
        }
        if (evt.type === "replace") {
          // Cumulative snapshot — authoritative for the current segment,
          // replaces whatever accumulated so far. 赋值天然幂等：同一快照
          // 重发 16 次结果不变，配合 sendDelta 的累计值比较也只下发一帧。
          usingAgentStream = true;
          agentSnapshotSeen = true;
          agentText = evt.text;
          sendDelta(agentText);
          return;
        }
        if (evt.type === "chat-delta") {
          if (usingAgentStream) return;
          chatText = evt.text;
          sendDelta(chatText);
          return;
        }
        // final/aborted/error mark the session's work done by default — but
        // if a message was steered into this session, a genuine terminal
        // event for the run that triggered it isn't the end of the whole
        // exchange, just one of (at least) two runs this connection covers.
        if (evt.type === "final") {
          if (steerOwner.consume()) {
            if (!usingAgentStream) chatText = evt.text;
            sendDelta(liveText());
            return;
          }
          sessionDone = true;
          finish({ type: "final", text: usingAgentStream ? agentText : evt.text });
          return;
        }
        if (evt.type === "aborted") {
          if (steerOwner.consume()) {
            if (!usingAgentStream) chatText = evt.text;
            sendDelta(liveText());
            return;
          }
          sessionDone = true;
          finish({ type: "aborted", text: usingAgentStream ? agentText : evt.text });
          return;
        }
        if (steerOwner.consume()) return;
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
          steerOwner.attachKey(canonicalSessionKey);
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
        let unknownStreak = 0;
        while (!sessionDone && !closed) {
          await sleep(POLL_INTERVAL_MS);
          if (Date.now() - lastPing >= 15_000) {
            lastPing = Date.now();
            send({ type: "ping" });
          }
          if (Date.now() < deadline) continue;
          // 安静够久了——问一次权威来源，而不是直接判死。
          const runState = await fetchSessionRunState(canonicalSessionKey);
          if (sessionDone || closed) break;
          if (runState === "running") {
            unknownStreak = 0;
            extendDeadline();
            continue;
          }
          if (runState === "unknown" && ++unknownStreak < MAX_UNKNOWN_STREAK) {
            deadline = Date.now() + UNKNOWN_RETRY_MS;
            continue;
          }
          // not-running（或权威来源连续多次答不上来）→ 收尾。
          break;
        }
        if (!sessionDone && !closed) {
          // 权威来源确认 run 已结束但 final 事件没到（事件丢失 / attach 晚
          // 于结束）——从 chat.history 兜底。fallback: true 让客户端知道这
          // 个 final 来自兜底：只有带此标记的 final 才做与上一条气泡的去重，
          // 且前端在流被掐断（工具/提问未收尾）时提示"回复可能不完整"。
          const text = await fetchLatestAssistantText(canonicalSessionKey);
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
