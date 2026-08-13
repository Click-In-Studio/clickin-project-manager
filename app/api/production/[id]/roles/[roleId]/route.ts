import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { } from "@/lib/permissions";
import { renameProductionRole, deleteProductionRole } from "@/lib/db";

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

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, roleId } = await ctx.params;
  const { deny } = await requireManage(req, id);
  if (deny) return deny;
  const body = (await req.json()) as { name?: string };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
  try {
    await renameProductionRole(roleId, id, name);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 403 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, roleId } = await ctx.params;
  const { deny } = await requireManage(req, id);
  if (deny) return deny;
  try {
    await deleteProductionRole(roleId, id);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 403 });
  }
  return Response.json({ ok: true });
}
