import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/perm/grant-check";
import { registerSSE, removePresence, presenceFrameFor } from "@/lib/server-cache";
import { registerSSEKick } from "@/lib/sse-kick";
import { getActiveVersionId, getVersion, getProductionPermissionContext } from "@/lib/db";
import { getSession } from "@/lib/account/session";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "script", "*", "blocks", "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const clientId = req.nextUrl.searchParams.get("cid") ?? Math.random().toString(36).slice(2);
  const connectionId = `${clientId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const versionId = req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  if (versionId) {
    const version = await getVersion(versionId);
    if (!version || version.productionId !== id) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
  }
  const enc = new TextEncoder();

  // 整套清理集中一处、幂等：cancel()（客户端断开）、push 失败（坏管道）、被踢（#469
  // 权限撤销，服务端主动 close 不触发 cancel()）三条路径都走它。
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (frame: string) => {
        try { controller.enqueue(enc.encode(frame)); }
        catch { teardown?.(); }
      };
      const cancelSSE = registerSSE(id, versionId, connectionId, clientId, session.userId, push);
      const releaseKick = registerSSEKick(id, session.userId, () => {
        teardown?.();
        try { controller.close(); } catch { /* 已关 */ }
      });
      let done = false;
      teardown = () => {
        if (done) return;
        done = true;
        releaseKick();
        const hasOtherConnections = cancelSSE();
        if (!hasOtherConnections) {
          removePresence(id, versionId, clientId);
        }
      };
      push(presenceFrameFor(id, versionId));
      push(`: connected\n\n`);
    },
    cancel() {
      teardown?.();
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
