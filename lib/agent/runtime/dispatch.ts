// next 侧的聊天流（#367）。网关已退役（2026-08），所有会话都走自建运行时。
//
// SSE 端点从 agent_event 直出：帧格式 `data: <json>\n\n`、ping 15s、行协议与网关时代
// 完全一致（stream-reducer 原样）。观看者只认 (session, seq) 游标，哪个进程在执行不可见。

import type { NextRequest } from "next/server";
import { SessionBusyError } from "./service";
import { startRun } from "./client";
import { readEventsSince, subscribeSessionEvents } from "./events";
import { EVENT_FALLBACK_MS, EventWakeup } from "./event-wakeup";
import { pageKeyForLabel } from "@/lib/agent/agent-page-context";
import { getPool } from "@/lib/pg";
import type { ApprovalInfo, StreamLine } from "@/lib/agent/chat/stream-reducer";

const UI_PAGE_RE = /^<clickin-ui-context>[\s\S]{0,600}?用户此刻位于「(.{1,40}?)」页面/;

/** 信封里的页面名 → pageKey（与 inject.ts 的识别方式同源）。 */
export function pageKeyOfMessage(message: string): string | null {
  return pageKeyForLabel(UI_PAGE_RE.exec(message)?.[1] ?? null);
}

/** 待答审批卡（attach 时补发——网关时代没有这条恢复路径，卡片刷新即丢）。 */
async function pendingApprovalLines(sessionId: string): Promise<StreamLine[]> {
  const r = await getPool().query<{ id: string; tool_call_id: string; preview: { title?: string; description?: string; severity?: ApprovalInfo["severity"]; purpose?: ApprovalInfo["purpose"] } }>(
    `SELECT id, tool_call_id, preview FROM agent_approval WHERE session_id = $1 AND status = 'pending' AND expires_at > now() ORDER BY created_at`,
    [sessionId],
  );
  return r.rows.map((row) => ({
    type: "approval",
    approval: {
      id: row.id,
      title: (row.preview.title ?? "").slice(0, 80),
      description: (row.preview.description ?? "").slice(0, 512),
      severity: row.preview.severity ?? "warning",
      allowedDecisions: ["allow-once", "deny"],
      purpose: row.preview.purpose,
      toolCallId: row.tool_call_id,
    },
  }));
}

/**
 * 自建运行时的聊天流。startRun 给了就先发起一轮（发消息），否则只 attach 到进行中的
 * 回复（重开会话）。attach 只看 attach 之后的事件（与网关 relay 的既有限制一致：
 * 历史由 /history 补），但补发待答的审批卡。
 */
export function createRunnerStreamResponse(
  req: NextRequest,
  sessionKey: string,
  options: { startRun?: () => Promise<{ runId: string }> } = {},
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      const wakeup = new EventWakeup(req.signal);
      const sentApprovals = new Set<string>();
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const send = (obj: StreamLine | { type: "session"; key: string; runId: string }) => {
        if (closed) return;
        // attach 补发的待答卡可能也落在订阅后补读的事件中，只展示一次。
        if (obj.type === "approval" && obj.approval) {
          if (sentApprovals.has(obj.approval.id)) return;
          sentApprovals.add(obj.approval.id);
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      cleanup = () => {
        unsubscribe?.();
        clearInterval(heartbeat);
        wakeup.close();
        req.signal.removeEventListener("abort", onClientGone);
      };
      const finish = (obj?: StreamLine) => {
        if (closed) return;
        if (obj) send(obj);
        closed = true;
        cleanup();
        controller.close();
      };
      const onClientGone = () => finish();
      req.signal.addEventListener("abort", onClientGone, { once: true });

      try {
        if (req.signal.aborted || closed) {
          finish();
          return;
        }
        send({ type: "ping" });
        // 心跳独立于读库与兜底节拍，通知频繁时也不会延后。
        heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
        // 保留 attach 只看当前末尾之后事件的语义；订阅完成后立即补读这个间隙。
        let cursor = await maxSeq(sessionKey);
        unsubscribe = await subscribeSessionEvents(sessionKey, wakeup.wake);
        if (closed) return;

        if (options.startRun) {
          const started = await options.startRun();
          send({ type: "session", key: sessionKey, runId: started.runId });
        } else {
          const state = await currentRunStatus(sessionKey);
          if (state === "compacting") send({ type: "compacting", active: true });
          if (state === null) {
            finish({ type: "final", text: "", fallback: true });
            return;
          }
          for (const line of await pendingApprovalLines(sessionKey)) send(line);
        }

        // 单循环串行读库；读库期间的通知只记一次待补读，不追加查询任务。
        while (!closed) {
          const rows = await readEventsSince(sessionKey, cursor);
          for (const row of rows) {
            if (closed) break;
            cursor = row.seq;
            const line = row.line;
            if (line.type === "final" || line.type === "aborted" || line.type === "error") {
              finish(line);
              return;
            }
            send(line);
          }
          if (!closed) await wakeup.wait(EVENT_FALLBACK_MS);
        }
      } catch (err) {
        if (err instanceof SessionBusyError) {
          finish({ type: "error", error: err.message });
          return;
        }
        finish({ type: "error", error: err instanceof Error ? err.message : "Agent run failed" });
      } finally {
        cleanup();
      }
    },
    cancel() {
      closed = true;
      cleanup();
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

async function maxSeq(sessionId: string): Promise<number> {
  const r = await getPool().query<{ seq: string | null }>(`SELECT MAX(seq)::text AS seq FROM agent_event WHERE session_id = $1`, [sessionId]);
  return r.rows[0]?.seq ? Number(r.rows[0].seq) : 0;
}

async function currentRunStatus(sessionId: string): Promise<string | null> {
  const r = await getPool().query<{ status: string }>(
    `SELECT status FROM agent_run
      WHERE session_id = $1
        AND status IN ('running', 'compacting', 'awaiting_approval', 'awaiting_answer')
      ORDER BY started_at DESC LIMIT 1`,
    [sessionId],
  );
  return r.rows[0]?.status ?? null;
}

export { startRun };
