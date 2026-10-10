import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { canViewWiki } from "@/lib/wiki/perm";
import { recordWikiVisit, wikiVisitTargetExists } from "@/lib/wiki/personal-navigation-db";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; wikiId: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, wikiId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  // 存在性在 owner 旁路前查；不接受 node/link id，也不披露外项目目标。
  if (!await wikiVisitTargetExists(id, wikiId))
    return Response.json({ error: "文档不存在" }, { status: 404 });
  if (!await canViewWiki(toActor(session, access.permCtx), id, wikiId))
    return Response.json({ error: "无权访问该文档" }, { status: 403 });
  if ((await req.text()).length > 0)
    return Response.json({ error: "访问记录请求体必须为空" }, { status: 400 });
  // 归档只禁止修改项目内容，不阻止保存个人访问历史。
  await recordWikiVisit(session.userId, id, wikiId);
  return new Response(null, { status: 204 });
}
