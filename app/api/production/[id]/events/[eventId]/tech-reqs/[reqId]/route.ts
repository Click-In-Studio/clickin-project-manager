import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, getEventTechReq, updateEventTechReq, deleteEventTechReq } from "@/lib/event-db";
import { loadEventPermContext, canEditTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访���" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事���不存在" }, { status: 404 });
  const existing = await getEventTechReq(reqId, eventId);
  if (!existing) return Response.json({ error: "技术需求不存在" }, { status: 404 });

  const eventPermCtx = await loadEventPermContext(session.userId, eventId);
  if (!canEditTechReq(permCtx, eventPermCtx, existing.departmentId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; description?: string;
    presetMinutes?: number | null; departmentId?: string | null; status?: string;
  };

  const updated = await updateEventTechReq(reqId, eventId, {
    title: body.title?.trim(),
    description: body.description,
    presetMinutes: body.presetMinutes,
    departmentId: body.departmentId,
    status: body.status,
  });
  return Response.json({ techReq: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:delete_tech_req_any", permCtx))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  await deleteEventTechReq(reqId, eventId);
  return Response.json({ ok: true });
}
