// next 侧的聊天流（#367）。网关已退役（2026-08），所有会话都走自建运行时。
//
// SSE 端点从 agent_event 直出：帧格式 `data: <json>\n\n`、ping 15s、行协议与网关时代
// 完全一致（stream-reducer 原样）。观看者只认 (session, seq) 游标，哪个进程在执行不可见。

import type { NextRequest } from "next/server";
import { SessionBusyError } from "./service";
import { startRun } from "./client";
import { readEventsSince, subscribeSessionEvents } from "./events";
import { pageKeyForLabel } from "@/lib/agent-page-context";
import { getPool } from "@/lib/pg";
import type { ApprovalInfo, StreamLine } from "@/lib/agent-chat/stream-reducer";

const UI_PAGE_RE = /^<clickin-ui-context>[\s\S]{0,600}?用户此刻位于「(.{1,40}?)」页面/;

/** 信封里的页面名 → pageKey（与 inject.ts 的识别方式同源）。 */
export function pageKeyOfMessage(message: string): string | null {
  return pageKeyForLabel(UI_PAGE_RE.exec(message)?.[1] ?? null);
}

/** 待答审批卡（attach 时补发——网关时代没有这条恢复路径，卡片刷新即丢）。 */
async function pendingApprovalLines(sessionId: string): Promise<StreamLine[]> {
  const r = await getPool().query<{ id: string; tool_call_id: string; preview: { title?: string; description?: string; severity?: ApprovalInfo["severity"] } }>(
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
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const finish = (obj?: unknown) => {
        if (closed) return;
        if (obj) send(obj);
        closed = true;
        unsubscribe?.();
        controller.close();
      };
      const onClientGone = () => {
        closed = true;
        unsubscribe?.();
      };
      req.signal.addEventListener("abort", onClientGone);
      if (req.signal.aborted) onClientGone();

      try {
        send({ type: "ping" });
        // 游标：发消息时从当前末尾起（本轮事件全部可见）；attach 同样从末尾起
        let cursor = await maxSeq(sessionKey);
        let terminal = false;
        let draining = Promise.resolve();
        const pump = () => {
          draining = draining.then(async () => {
            if (closed || terminal) return;
            const rows = await readEventsSince(sessionKey, cursor);
            for (const row of rows) {
              cursor = row.seq;
              const line = row.line;
              if (line.type === "final" || line.type === "aborted" || line.type === "error") {
                terminal = true;
                finish(line);
                return;
              }
              send(line);
            }
          }).catch((err) => {
            console.error("[agent-runtime] stream pump error:", err);
          });
        };
        unsubscribe = await subscribeSessionEvents(sessionKey, () => pump());

        if (options.startRun) {
          const started = await options.startRun();
          send({ type: "session", key: sessionKey, runId: started.runId });
        } else {
          for (const line of await pendingApprovalLines(sessionKey)) send(line);
        }

        // 心跳 + 轮询兜底（NOTIFY 丢失/连接抖动时游标照样推进）
        let lastPing = Date.now();
        while (!closed && !terminal) {
          await new Promise((r) => setTimeout(r, 1000));
          pump();
          if (Date.now() - lastPing >= 15_000) {
            lastPing = Date.now();
            send({ type: "ping" });
          }
        }
        await draining;
      } catch (err) {
        if (err instanceof SessionBusyError) {
          finish({ type: "error", error: err.message });
          return;
        }
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

async function maxSeq(sessionId: string): Promise<number> {
  const r = await getPool().query<{ seq: string | null }>(`SELECT MAX(seq)::text AS seq FROM agent_event WHERE session_id = $1`, [sessionId]);
  return r.rows[0]?.seq ? Number(r.rows[0].seq) : 0;
}

export { startRun };
