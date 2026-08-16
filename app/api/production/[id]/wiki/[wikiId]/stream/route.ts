import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { canViewWiki } from "@/lib/wiki-perm";
import {
  registerWikiSSE, registerWikiLibrarySSE, updateWikiPresence, removeWikiPresence, wikiPresenceFrame,
} from "@/lib/wiki-collab";

// wiki 文档 SSE（多人协作）：presence（在场者+光标块索引）与 update（内容广播），
// 外加所属制作的 library 帧（结构变化：增/删/移动/改名/换标签）——后者影响的是
// 左侧树和"我正开着的这篇被删了"，但不值得为它多开一条连接，所以同一条流上
// 多订一个 topic。照 script stream 同款结构；门=对本文档的可见性。

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; wikiId: string }> }) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await canViewWiki(toActor(session, access.permCtx), productionId, wikiId))
    return Response.json({ error: "无权访问该文档" }, { status: 403 });

  const clientId = req.nextUrl.searchParams.get("cid") ?? Math.random().toString(36).slice(2);
  const connectionId = `${clientId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  let cancelSSE: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (frame: string) => {
        try { controller.enqueue(enc.encode(frame)); }
        catch { cancelSSE?.(); }
      };
      const cancelDoc = registerWikiSSE(wikiId, connectionId, push);
      const cancelLibrary = registerWikiLibrarySSE(productionId, connectionId, push);
      cancelSSE = () => { cancelDoc(); cancelLibrary(); };
      // 上线即入场（阅读态光标为 null）
      updateWikiPresence(wikiId, clientId, {
        userId: session.userId, userName: session.name, avatarUrl: session.avatarUrl ?? null,
      }, null);
      push(wikiPresenceFrame(wikiId));
      push(`: connected\n\n`);
    },
    cancel() {
      cancelSSE?.();
      removeWikiPresence(wikiId, clientId);
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
