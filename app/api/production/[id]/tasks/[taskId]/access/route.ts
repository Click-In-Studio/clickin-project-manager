import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getTechReqByProduction } from "@/lib/event-db";
import {
  getTechReqAccess,
  selfConfirmResourceGrant,
  checkNodeFreeApprovalZone,
} from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

/** GET — 任务编辑权三态（event-scoped access 路由的 production 级版；独立任务可用）。 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, taskId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const task = await getTechReqByProduction(taskId, productionId);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });

  // owner/admin 旁路：三态判定只读授权行表，旁路语义必须在入口短路
  const { permCtx } = access;
  if (session.isAdmin || permCtx.isAdmin || permCtx.isOwner)
    return Response.json({ canAccess: true, level: "manage" });

  const result = await getTechReqAccess(session.userId, productionId, taskId);
  return Response.json(result);
}

/** POST { action: "self_confirm", level } — 免审批区间自确认拿编辑权。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, taskId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const task = await getTechReqByProduction(taskId, productionId);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });

  const body = await req.json() as { action?: string; level?: string };
  if (body.action !== "self_confirm")
    return Response.json({ error: "未知操作" }, { status: 400 });

  const level = body.level as "edit" | "manage" | undefined;
  if (level !== "edit" && level !== "manage")
    return Response.json({ error: "无效的权限级别" }, { status: 400 });

  const inZone = await checkNodeFreeApprovalZone(
    session.userId, productionId, "task", taskId, level,
  );
  if (!inZone)
    return Response.json({ error: "不在免审批区间，无法自我确认" }, { status: 403 });

  await selfConfirmResourceGrant(session.userId, productionId, "task", taskId, level);
  return Response.json({ ok: true });
}
