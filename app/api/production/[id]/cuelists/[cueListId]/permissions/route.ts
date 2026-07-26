import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext, getCueList, listCueListPermissions, setCueListPermission,
} from "@/lib/db";
import { hasScopedPermission } from "@/lib/permissions";

// PATCH /api/production/[id]/cuelists/[cueListId]/permissions
// body: { userId: string; canEdit: boolean | null }  (null = remove override)
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/permissions">
) {
  const { id, cueListId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const cueList = await getCueList(cueListId, id);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  const isCreator = cueList.createdBy === session.userId;
  if (!hasScopedPermission("cue_list:manage_permissions", "cue_list:manage_permissions_any", isCreator, permCtx))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as { userId: string; canEdit: boolean | null };
  if (!body.userId) return Response.json({ error: "缺少 userId" }, { status: 400 });

  await setCueListPermission(cueListId, body.userId, body.canEdit);
  const permissions = await listCueListPermissions(cueListId);
  return Response.json(permissions);
}
