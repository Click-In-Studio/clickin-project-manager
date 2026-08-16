import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getCueList, updateCueList, deleteCueList,
  hasListAccess, listProductionDepts,
} from "@/lib/db";
import { listCueListGrants, listCueListDeptAccess } from "@/lib/resource-grant-db";
import { canAccessNode } from "@/lib/grant-template";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { type PermissionContext } from "@/lib/permissions";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, permCtx: null as PermissionContext | null, isArchived: false };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { session, permCtx: null as PermissionContext | null, isArchived: false };
  const { permCtx, isArchived } = access;
  return { session, permCtx, isArchived };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]">) {
  const { id, cueListId } = await ctx.params;
  const { session, permCtx } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!permCtx) return Response.json({ error: "无权访问" }, { status: 403 });
  // 批A 三态：目录行可见性（meta view）在前，内容/管理各看各的行
  const metaAccess = await canAccessNode(permCtx, id, "cue_list", cueListId, "meta", "view");
  if (!metaAccess.allowed) return Response.json({ error: "无权访问" }, { status: 403 });

  const [cueList, canEdit] = await Promise.all([
    getCueList(cueListId, id),
    hasListAccess(cueListId, session.userId),
  ]);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });

  const canManage = await hasEffectiveGrant(
    toActor(session, permCtx),
    id, "cue_list", cueListId, "grants", "edit",
  );

  const [grants, deptAccess, productionDepts] = await Promise.all([
    canManage ? listCueListGrants(cueListId) : Promise.resolve([]),
    canManage ? listCueListDeptAccess(cueListId) : Promise.resolve([]),
    canManage ? listProductionDepts(id) : Promise.resolve([]),
  ]);

  return Response.json({ cueList, grants, deptAccess, productionDepts, canEdit, canManage });
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]">) {
  const { id, cueListId } = await ctx.params;
  const { session, permCtx, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!permCtx) return Response.json({ error: "无权访问" }, { status: 403 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const [cueList, canEdit] = await Promise.all([
    getCueList(cueListId, id),
    hasListAccess(cueListId, session.userId),
  ]);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  if (!canEdit)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { name?: string; notes?: string; abbr?: string | null };
  const fields: Parameters<typeof updateCueList>[2] = {
    name:  body.name?.trim(),
    notes: body.notes?.trim(),
  };
  if ("abbr" in body) fields.abbr = body.abbr?.trim().toUpperCase() || null;

  try {
    await updateCueList(cueListId, id, fields);
  } catch (e: unknown) {
    if ((e as { constraint?: string }).constraint === "cue_list_abbr_production_unique")
      return Response.json({ error: "简称已被同项目其他Cue表使用" }, { status: 409 });
    throw e;
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]">) {
  const { id, cueListId } = await ctx.params;
  const { session, permCtx, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!permCtx) return Response.json({ error: "无权访问" }, { status: 403 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const cueList = await getCueList(cueListId, id);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  // 批A：实例节点 delete 动词行（创建者自动行集/管理员通配/迁移拆解行）
  const delAccess = await canAccessNode(permCtx, id, "cue_list", cueListId, "*", "delete");
  if (!delAccess.allowed)
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteCueList(cueListId, id);
  return Response.json({ ok: true });
}
