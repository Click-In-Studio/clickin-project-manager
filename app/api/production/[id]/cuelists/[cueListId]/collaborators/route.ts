import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getCueList } from "@/lib/ops/cue-list-db";
import { listProductionDeptNames } from "@/lib/perm/dept-db";
import {
  listCueListGrants, listCueListDeptAccess,
  addCueListDeptAccess, removeCueListDeptAccess,
  setCueListGrant, type CueListLevel,
} from "@/lib/perm/resource-grant-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { kickRevokedStreams } from "@/lib/perm/revoke-streams";

async function getManageCtx(req: NextRequest, productionId: string, cueListId: string) {
  const session = getSession(req.cookies);
  if (!session) return null;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return null;
  const cueList = await getCueList(cueListId, productionId);
  if (!cueList) return null;
  // 批A：管理面 = grants 显式行（admin/owner 旁路）
  const canManage = await hasEffectiveGrant(
    toActor(session, access.permCtx),
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
    listProductionDeptNames(id),
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
    kickRevokedStreams(id); // #469：整个部门失去这张表，踢整个 production
  } else if (body.type === "user" && body.userId) {
    await setCueListGrant(cueListId, id, body.userId, false, mc.session.userId);
    kickRevokedStreams(id, body.userId); // #469
  } else {
    return Response.json({ error: "参数错误" }, { status: 400 });
  }

  const [grants, deptAccess] = await Promise.all([
    listCueListGrants(cueListId),
    listCueListDeptAccess(cueListId),
  ]);
  return Response.json({ grants, deptAccess });
}
