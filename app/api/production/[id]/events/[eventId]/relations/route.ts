import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getProductionEvent, listEventMilestoneIds, listProductionTechReqs, setEventRelations } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await getProductionEvent(eventId, productionId)) return Response.json({ error: "事件不存在" }, { status: 404 });
  const [tasks, milestoneIds] = await Promise.all([
    listProductionTechReqs(productionId),
    listEventMilestoneIds(eventId, productionId),
  ]);
  return Response.json({ taskIds: tasks.filter(task => task.eventId === eventId).map(task => task.id), milestoneIds });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "event", eventId, "details", "edit")) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  const body = await req.json() as { taskIds?: unknown; milestoneIds?: unknown };
  const taskIds = Array.isArray(body.taskIds) ? [...new Set(body.taskIds.filter((id): id is string => typeof id === "string"))] : [];
  const milestoneIds = Array.isArray(body.milestoneIds) ? [...new Set(body.milestoneIds.filter((id): id is string => typeof id === "string"))] : [];
  try {
    await setEventRelations(eventId, productionId, taskIds, milestoneIds);
    return Response.json({ ok: true, taskIds, milestoneIds });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存关联失败" }, { status: 400 });
  }
}
