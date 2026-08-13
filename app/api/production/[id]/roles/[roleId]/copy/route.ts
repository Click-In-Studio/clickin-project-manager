import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { copyProductionRole } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; roleId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  if (!session.isAdmin && !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, productionId, "member", "*", "overrides", "edit")))
    return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  if (access.isArchived) return { deny: Response.json({ error: "已归档" }, { status: 403 }) };
  return { deny: null };
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, roleId } = await ctx.params;
  const { deny } = await requireManage(req, id);
  if (deny) return deny;
  const body = (await req.json()) as { name?: string };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
  const role = await copyProductionRole(id, roleId, name);
  return Response.json({ role }, { status: 201 });
}
