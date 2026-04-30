import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getCueList, updateCueList, deleteCueList,
  listCueListPermissions,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { canEditCueList, canManageCueListPermissions } from "@/lib/cue-list-types";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]">) {
  const { id, cueListId } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const [cueList, permissions] = await Promise.all([
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
  ]);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });

  const canEdit = canEditCueList(session.openId, memberRoles, session.isAdmin, cueList, permissions);
  const canManage = canManageCueListPermissions(session.openId, memberRoles, session.isAdmin, cueList);
  return Response.json({ cueList, permissions, canEdit, canManage });
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]">) {
  const { id, cueListId } = await ctx.params;
  const { session, memberRoles, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const [cueList, permissions] = await Promise.all([
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
  ]);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  if (!canEditCueList(session.openId, memberRoles, session.isAdmin, cueList, permissions))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { name?: string; notes?: string };
  await updateCueList(cueListId, id, {
    name:  body.name?.trim(),
    notes: body.notes?.trim(),
  });
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]">) {
  const { id, cueListId } = await ctx.params;
  const { session, memberRoles, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const cueList = await getCueList(cueListId, id);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  if (!canManageCueListPermissions(session.openId, memberRoles, session.isAdmin, cueList))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteCueList(cueListId, id);
  return Response.json({ ok: true });
}
