import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { canViewWiki } from "@/lib/wiki/perm";
import { updateWikiPresence } from "@/lib/wiki/collab";

// 光标位置上报（富文本顶层块索引=协作"行"）；经 SSE presence 帧扇出

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; wikiId: string }> }) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await canViewWiki(toActor(session, access.permCtx), productionId, wikiId))
    return Response.json({ error: "无权访问该文档" }, { status: 403 });

  let body: { clientId?: string; blockIndex?: number | null; offset?: number | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "无效请求体" }, { status: 400 });
  }
  if (!body.clientId) return Response.json({ error: "缺 clientId" }, { status: 400 });
  updateWikiPresence(wikiId, body.clientId, {
    userId: session.userId, userName: session.name, avatarUrl: session.avatarUrl ?? null,
  }, typeof body.blockIndex === "number"
    ? { blockIndex: body.blockIndex, offset: typeof body.offset === "number" ? Math.max(0, body.offset) : 0 }
    : null);
  return Response.json({ ok: true });
}
