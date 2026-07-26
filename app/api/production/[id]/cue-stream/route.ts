import { type NextRequest } from "next/server";
import { registerCueSSE, removeCuePresence, cuePresenceFrame } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !hasPermission("cue_list:view", access.permCtx))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const clientId = req.nextUrl.searchParams.get("cid") ?? Math.random().toString(36).slice(2);
  const enc = new TextEncoder();

  let cancel: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (frame: string) => {
        try { controller.enqueue(enc.encode(frame)); }
        catch { cancel?.(); }
      };
      cancel = registerCueSSE(id, clientId, push);
      push(cuePresenceFrame(id));
      push(`: connected\n\n`);
    },
    cancel() {
      cancel?.();
      removeCuePresence(id, clientId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
