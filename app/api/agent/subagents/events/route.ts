import { type NextRequest } from "next/server";
import { requireSubagentParent } from "@/lib/agent/runtime/subagent-route-auth";
import { toErrorResponse } from "@/lib/agent/chat/http";
import { listSubagents } from "@/lib/agent/runtime/subagent-db";
import { subscribeSessionEvents } from "@/lib/agent/runtime/events";
import { sessionRuntimeStatus } from "@/lib/agent/runtime/session-runtime-db";

import { registerSSEKick } from "@/lib/sse-kick";
import { registerSSEKeepalive } from "@/lib/sse-keepalive";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    const auth = await requireSubagentParent(
      req,
      req.nextUrl.searchParams.get("sessionKey"),
    );
    if (auth instanceof Response) return auth;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        let chain = Promise.resolve();
        let signature = "";
        const update = () => {
          chain = chain
            .then(async () => {
              if (closed) return;
              const subagents = (await listSubagents(auth.sessionKey)).map(
                (r) => ({ ...r, result: r.result?.slice(0, 800) ?? null }),
              );
              const data = {
                subagents,
                parentStatus: await sessionRuntimeStatus(auth.sessionKey),
              };
              const next = JSON.stringify(data);
              if (next !== signature && !closed) {
                signature = next;
                controller.enqueue(encoder.encode(`data: ${next}\n\n`));
              }
            })
            .catch(() => {
              if (!closed) {
                closed = true;
                cleanup();
                controller.close();
              }
            });
        };
        const unsubscribe = await subscribeSessionEvents(
          auth.sessionKey,
          update,
        );
        const releaseKeepalive = registerSSEKeepalive((frame) => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(frame));
            } catch {
              cleanup();
            }
          }
        });
        const timer = setInterval(() => {
          if (!closed) update();
        }, 15_000);
        timer.unref?.();
        const finish = () => {
          if (closed) return;
          cleanup();
          controller.close();
        };
        const releaseKick = auth.productionId
          ? registerSSEKick(auth.productionId, auth.userId, finish)
          : () => {};
        cleanup = () => {
          closed = true;
          releaseKick();
          releaseKeepalive();
          unsubscribe();
          clearInterval(timer);
          req.signal.removeEventListener("abort", finish);
        };
        req.signal.addEventListener("abort", finish, { once: true });
        if (req.signal.aborted) {
          finish();
          return;
        }
        update();
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
