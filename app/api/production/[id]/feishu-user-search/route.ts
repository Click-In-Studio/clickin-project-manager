import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, searchUsersByName, listAllUsersWithContact } from "@/lib/db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) {
    const { id } = await ctx.params;
    const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
    if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
    const { permCtx } = access;
    if (!(permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "member", "*", "*", "create")))
      return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  const users = q ? await searchUsersByName(q) : await listAllUsersWithContact();
  return Response.json({ users });
}
