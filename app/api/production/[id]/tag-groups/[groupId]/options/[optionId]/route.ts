import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, updateTagOption, deleteTagOption } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; groupId: string; optionId: string }> }) {
  const { id, optionId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const params: { label?: string; color?: string; sortOrder?: number } = {};
  if (typeof body.label     === "string") params.label     = body.label.trim();
  if (typeof body.color     === "string") params.color     = body.color;
  if (typeof body.sortOrder === "number") params.sortOrder = body.sortOrder;

  const option = await updateTagOption(optionId, params);
  if (!option) return Response.json({ error: "选项不存在" }, { status: 404 });
  return Response.json({ ok: true, option });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; groupId: string; optionId: string }> }) {
  const { id, optionId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(_req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  await deleteTagOption(optionId);
  return Response.json({ ok: true });
}
