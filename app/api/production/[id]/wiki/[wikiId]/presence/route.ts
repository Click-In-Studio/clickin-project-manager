import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { canViewWiki } from "@/lib/wiki/perm";
import { hasWikiPresence, updateWikiPresence } from "@/lib/wiki/collab";

// 光标位置上报（富文本顶层块索引=协作"行"）与在场心跳（#578）；经 SSE presence 帧扇出

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; wikiId: string }> }) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  let body: { clientId?: string; blockIndex?: number | null; offset?: number | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "无效请求体" }, { status: 400 });
  }
  if (!body.clientId) return Response.json({ error: "缺 clientId" }, { status: 400 });

  // 快路径（#578，同 #460）：本人以这个 clientId 在场 = stream 建连时已过与下面逐字
  // 相同的可见性门，且连接拆除即出场——心跳不重跑可见性查询。撤销时效边界同
  // script presence：撤销写点主动断流（#469）后快路径自然失效。
  if (!hasWikiPresence(wikiId, body.clientId, session.userId)) {
    const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
    if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
    if (!await canViewWiki(toActor(session, access.permCtx), productionId, wikiId))
      return Response.json({ error: "无权访问该文档" }, { status: 403 });
  }
  updateWikiPresence(wikiId, body.clientId, {
    userId: session.userId, userName: session.name, avatarUrl: session.avatarUrl ?? null,
  }, typeof body.blockIndex === "number"
    ? { blockIndex: body.blockIndex, offset: typeof body.offset === "number" ? Math.max(0, body.offset) : 0 }
    : null);
  return Response.json({ ok: true });
}
