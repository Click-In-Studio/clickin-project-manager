import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getState } from "@/lib/server-cache";
import { computePageMap } from "@/lib/script-page";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]/pages">) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const versionId = req.nextUrl.searchParams.get("v") ?? await getActiveVersionId(id) ?? '';
  const { blocks } = getState(id, versionId);
  return Response.json({ pageMap: computePageMap(blocks) });
}
