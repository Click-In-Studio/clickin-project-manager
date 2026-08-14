import { type NextRequest } from "next/server";
import { hasEventContentEdit } from "@/lib/event-permissions";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getScheduleItem, updateScheduleItem, deleteScheduleItem, setScheduleItemDepartments } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string; itemId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, itemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const existing = await getScheduleItem(itemId, eventId);

  if (!await hasEventContentEdit(toActor(session, permCtx), productionId, eventId, event.status))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (!existing) return Response.json({ error: "流程项不存在" }, { status: 404 });

  const body = (await req.json()) as {
    title?: string; itemType?: string; startTime?: string | null;
    endTime?: string | null; location?: string; orderIndex?: number;
    targetSceneId?: string | null; targetBlockId?: string | null; notes?: string;
    departmentIds?: string[];
  };

  const [updated] = await Promise.all([
    updateScheduleItem(itemId, eventId, {
      title: body.title?.trim(),
      itemType: body.itemType,
      startTime: body.startTime,
      endTime: body.endTime,
      location: body.location,
      orderIndex: body.orderIndex,
      targetSceneId: body.targetSceneId,
      targetBlockId: body.targetBlockId,
      notes: body.notes,
    }),
    body.departmentIds !== undefined
      ? setScheduleItemDepartments(itemId, body.departmentIds)
      : Promise.resolve(),
  ]);
  return Response.json({ item: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, itemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  if (!await hasEventContentEdit(toActor(session, permCtx), productionId, eventId, event.status))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteScheduleItem(itemId, eventId);
  return Response.json({ ok: true });
}
