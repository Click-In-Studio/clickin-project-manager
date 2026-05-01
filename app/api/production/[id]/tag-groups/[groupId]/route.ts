import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, updateTagGroup, deleteTagGroup } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; groupId: string }> }) {
  const { id, groupId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const params: {
    name?: string;
    rangeMin?: number | null;
    rangeMax?: number | null;
    rangeStep?: number | null;
    rangeDefault?: number | null;
    defaultOptionId?: string | null;
    lyricSplitAfterOptionId?: string | null;
    sortOrder?: number;
  } = {};
  if (typeof body.name         === "string") params.name         = body.name.trim();
  if ("rangeMin"     in body)                params.rangeMin     = body.rangeMin     ?? null;
  if ("rangeMax"     in body)                params.rangeMax     = body.rangeMax     ?? null;
  if ("rangeStep"    in body)                params.rangeStep    = body.rangeStep    ?? null;
  if ("rangeDefault" in body)                params.rangeDefault = body.rangeDefault ?? null;
  if ("defaultOptionId"           in body)   params.defaultOptionId           = body.defaultOptionId           ?? null;
  if ("lyricSplitAfterOptionId"   in body)   params.lyricSplitAfterOptionId   = body.lyricSplitAfterOptionId   ?? null;
  if (typeof body.sortOrder    === "number") params.sortOrder    = body.sortOrder;

  const group = await updateTagGroup(groupId, params);
  if (!group) return Response.json({ error: "分组不存在" }, { status: 404 });
  return Response.json({ ok: true, group });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; groupId: string }> }) {
  const { id, groupId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(_req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  await deleteTagGroup(groupId);
  return Response.json({ ok: true });
}
