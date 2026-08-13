import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission, ROLE_TEMPLATE_EXCLUDED } from "@/lib/permissions";
import { setRolePermissions } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; roleId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  if (!session.isAdmin && !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "member", "*", "overrides", "edit")))
    return { deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  if (access.isArchived) return { deny: Response.json({ error: "已归档" }, { status: 403 }) };
  return { deny: null };
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id, roleId } = await ctx.params;
  const { deny } = await requireManage(req, id);
  if (deny) return deny;
  const body = (await req.json()) as { permissions?: unknown };
  if (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== "string"))
    return Response.json({ error: "permissions 必须是字符串数组" }, { status: 400 });
  const filtered = (body.permissions as string[]).filter((p) => !ROLE_TEMPLATE_EXCLUDED.has(p as never));
  await setRolePermissions(roleId, filtered);
  return Response.json({ ok: true, permissions: filtered });
}
