import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { listBacklinks, listUnlinkedReferences } from "@/lib/wiki-db";
import { canViewWiki } from "@/lib/wiki-perm";

type Ctx = { params: Promise<{ id: string; wikiId: string }> };

// backlinks / unlinked references 面板：标题级列出（§4.1——含观看者无权阅读的来源，
// 点击处由目标页过门+申请）。门=对本文档的可见性（面板长在文档页上）。

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  if (!await canViewWiki(actor, productionId, wikiId))
    return Response.json({ error: "无权访问该文档" }, { status: 403 });

  const [backlinks, unlinked] = await Promise.all([
    listBacklinks(wikiId, productionId),
    listUnlinkedReferences(wikiId, productionId),
  ]);
  return Response.json({ backlinks, unlinked });
}
