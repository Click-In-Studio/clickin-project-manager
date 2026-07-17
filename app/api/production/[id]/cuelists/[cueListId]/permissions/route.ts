import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getCueList, listCueListPermissions, setCueListPermission,
} from "@/lib/db";
import { canManageCueListPermissions } from "@/lib/cue-list-types";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

// PATCH /api/production/[id]/cuelists/[cueListId]/permissions
// body: { openId: string; canEdit: boolean | null }  (null = remove override)
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/permissions">
) {
  const { id, cueListId } = await ctx.params;
  const { session, memberRoles, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const cueList = await getCueList(cueListId, id);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  if (!canManageCueListPermissions(session.openId, memberRoles, session.isAdmin, cueList))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { openId: string; canEdit: boolean | null };
  if (!body.openId) return Response.json({ error: "缺少 openId" }, { status: 400 });

  await setCueListPermission(cueListId, body.openId, body.canEdit);
  const permissions = await listCueListPermissions(cueListId);
  return Response.json(permissions);
}
