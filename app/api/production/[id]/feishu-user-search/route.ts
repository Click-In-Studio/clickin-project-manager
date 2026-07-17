import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, searchFeishuUsers } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) {
    const { id } = await ctx.params;
    const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
    if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides))
      return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 1) return Response.json({ users: [] });

  const users = await searchFeishuUsers(q);
  return Response.json({ users });
}
