import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getCueList, listProductionDepts } from "@/lib/db";
import {
  listCueListGrants, listCueListDeptAccess,
  addCueListDeptAccess, removeCueListDeptAccess,
  setCueListGrant, type CueListLevel,
} from "@/lib/resource-grant-db";
import { hasEffectiveGrant } from "@/lib/grant-check";

async function getManageCtx(req: NextRequest, productionId: string, cueListId: string) {
  const session = getSession(req.cookies);
  if (!session) return null;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return null;
  const cueList = await getCueList(cueListId, productionId);
  if (!cueList) return null;
  // 批A：管理面 = grants 显式行（admin/owner 旁路）
  const canManage = await hasEffectiveGrant(
    { userId: session.userId, isAdmin: access.permCtx.isAdmin, isOwner: access.permCtx.isOwner },
    productionId, "cue_list", cueListId, "grants", "edit",
  );
  return { session, canManage, productionId, isArchived: access.isArchived };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/collaborators">) {
  const { id, cueListId } = await ctx.params;
  const mc = await getManageCtx(req, id, cueListId);
  if (!mc) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!mc.canManage) return Response.json({ error: "无管理权限" }, { status: 403 });

  const [grants, deptAccess, productionDepts] = await Promise.all([
    listCueListGrants(cueListId),
    listCueListDeptAccess(cueListId),
    listProductionDepts(id),
  ]);
  return Response.json({ grants, deptAccess, productionDepts });
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/collaborators">) {
  const { id, cueListId } = await ctx.params;
  const mc = await getManageCtx(req, id, cueListId);
  if (!mc) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!mc.canManage) return Response.json({ error: "无管理权限" }, { status: 403 });
  if (mc.isArchived) return Response.json({ error: "已归档" }, { status: 403 });

  const body = await req.json() as { type: "user" | "dept"; userId?: string; deptId?: string; level?: CueListLevel };
  const VALID_LEVELS: CueListLevel[] = ["view", "mount", "edit", "manage"];

  if (body.type === "dept" && body.deptId) {
    await addCueListDeptAccess(cueListId, id, body.deptId, mc.session.userId);
  } else if (body.type === "user" && body.userId) {
    if (body.level && !VALID_LEVELS.includes(body.level))
      return Response.json({ error: "无效的权限级别" }, { status: 400 });
    const level: CueListLevel = (body.level as CueListLevel | undefined) ?? "edit";
    await setCueListGrant(cueListId, id, body.userId, true, mc.session.userId, level);
  } else {
    return Response.json({ error: "参数错误" }, { status: 400 });
  }

  const [grants, deptAccess] = await Promise.all([
    listCueListGrants(cueListId),
    listCueListDeptAccess(cueListId),
  ]);
  return Response.json({ grants, deptAccess });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/collaborators">) {
  const { id, cueListId } = await ctx.params;
  const mc = await getManageCtx(req, id, cueListId);
  if (!mc) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!mc.canManage) return Response.json({ error: "无管理权限" }, { status: 403 });
  if (mc.isArchived) return Response.json({ error: "已归档" }, { status: 403 });

  const body = await req.json() as { type: "user" | "dept"; userId?: string; deptId?: string };

  if (body.type === "dept" && body.deptId) {
    await removeCueListDeptAccess(cueListId, id, body.deptId);
  } else if (body.type === "user" && body.userId) {
    await setCueListGrant(cueListId, id, body.userId, false, mc.session.userId);
  } else {
    return Response.json({ error: "参数错误" }, { status: 400 });
  }

  const [grants, deptAccess] = await Promise.all([
    listCueListGrants(cueListId),
    listCueListDeptAccess(cueListId),
  ]);
  return Response.json({ grants, deptAccess });
}
