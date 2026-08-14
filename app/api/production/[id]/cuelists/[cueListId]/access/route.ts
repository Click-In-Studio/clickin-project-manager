/**
 * GET  — 查询当前用户对某个 cue list 的访问级别及自我确认可能性。
 * POST — 自我确认（写入 production_member_grant(self_confirmed)）。
 *
 * GET 响应:
 *   { canAccess: true, level: 'manage'|'edit'|'view' }
 *   { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'manage'|'edit' }
 *   { canAccess: false, canSelfConfirm: false }
 *
 * POST 请求体:
 *   { action: 'self_confirm', level: 'edit'|'manage' }
 *
 * POST 响应:
 *   { ok: true }
 */
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getCueList } from "@/lib/db";
import {
  getCueListAccess,
  selfConfirmCueListGrant,
  checkCueListFreeApprovalZone,
} from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; cueListId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, cueListId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  // 批A：自身访问状态查询，成员资格即可

  const cueList = await getCueList(cueListId, productionId);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });

  const result = await getCueListAccess(session.userId, productionId, cueListId);
  return Response.json(result);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, cueListId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const cueList = await getCueList(cueListId, productionId);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });

  const body = await req.json() as { action?: string; level?: string };
  if (body.action !== "self_confirm")
    return Response.json({ error: "未知操作" }, { status: 400 });

  const level = body.level as "edit" | "manage" | undefined;
  if (level !== "edit" && level !== "manage")
    return Response.json({ error: "无效的权限级别" }, { status: 400 });

  const inZone = await checkCueListFreeApprovalZone(
    session.userId, productionId, cueListId, level,
  );
  if (!inZone)
    return Response.json({ error: "不在免审批区间，无法自我确认" }, { status: 403 });

  await selfConfirmCueListGrant(session.userId, productionId, cueListId, level);
  return Response.json({ ok: true });
}
