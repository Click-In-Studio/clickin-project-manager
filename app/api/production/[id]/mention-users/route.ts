import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionMembers } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("script:comment", permCtx)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const members = await listProductionMembers(id);
  return Response.json({ users: members.map(m => ({ userId: m.userId, name: m.name, avatarUrl: m.avatarUrl ?? null })) });
}
