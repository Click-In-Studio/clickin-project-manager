import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { getWikiPersonalNavigation } from "@/lib/wiki/personal-navigation-db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  const headers = { "Cache-Control": "private, no-store" };
  if (!session) return Response.json({ error: "未登录" }, { status: 401, headers });
  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403, headers });
  return Response.json(await getWikiPersonalNavigation(toActor(session, access.permCtx), id), { headers });
}
