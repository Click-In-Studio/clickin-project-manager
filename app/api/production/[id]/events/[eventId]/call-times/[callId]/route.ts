import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, updateEventCallTime, deleteEventCallTime } from "@/lib/event-db";
import { hasResourceGrantLevel } from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; eventId: string; callId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, callId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  if (!permCtx.isAdmin && !await hasResourceGrantLevel(session.userId, productionId, "event", eventId, "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    name?: string; departmentId?: string | null;
    callAt?: string; scheduleItemId?: string | null; notes?: string;
  };

  const updated = await updateEventCallTime(callId, eventId, {
    name: body.name,
    departmentId: body.departmentId,
    callAt: body.callAt,
    scheduleItemId: body.scheduleItemId,
    notes: body.notes,
  });
  if (!updated) return Response.json({ error: "Call time 不存在" }, { status: 404 });
  return Response.json({ callTime: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, callId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  if (!permCtx.isAdmin && !await hasResourceGrantLevel(session.userId, productionId, "event", eventId, "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteEventCallTime(callId, eventId);
  return Response.json({ ok: true });
}
