import { type NextRequest } from "next/server";
import { registerCueSSE, removeCuePresence, cuePresenceFrame } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasAnyEffectiveGrant } from "@/lib/grant-check";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  // 批A：全项目级通道——任一 cue 表可见即可接入（admin/owner 旁路）
  const canSee = await hasAnyEffectiveGrant(
    { userId: session.userId, isAdmin: access.permCtx.isAdmin, isOwner: access.permCtx.isOwner },
    id, "cue_list", ["meta", "cues"], "view",
  );
  if (!canSee) return Response.json({ error: "无权访问" }, { status: 403 });

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
