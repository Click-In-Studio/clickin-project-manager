import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, updateProductionEvent, deleteProductionEvent, setEventStageManagers, completeAllEventTechReqs } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  return Response.json({ event });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:edit", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const existing = await getProductionEvent(eventId, productionId);
  if (!existing) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as {
    title?: string; eventType?: string; location?: string;
    startTime?: string | null; endTime?: string | null;
    status?: string; description?: string;
    stageManagers?: { openId: string; name: string }[];
  };

  const validStatuses = new Set(["draft", "published", "completed", "cancelled"]);
  if (body.status && !validStatuses.has(body.status))
    return Response.json({ error: "无效的状态值" }, { status: 400 });

  await updateProductionEvent(eventId, productionId, {
    title: body.title?.trim(),
    eventType: body.eventType,
    location: body.location,
    startTime: body.startTime,
    endTime: body.endTime,
    status: body.status as Parameters<typeof updateProductionEvent>[2]["status"],
    description: body.description,
  });
  if (body.status === "completed") {
    await completeAllEventTechReqs(eventId);
  }
  if (body.stageManagers !== undefined) {
    await setEventStageManagers(eventId, body.stageManagers);
  }
  const updated = await getProductionEvent(eventId, productionId);

  return Response.json({ event: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:edit", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const existing = await getProductionEvent(eventId, productionId);
  if (!existing) return Response.json({ error: "事件不存在" }, { status: 404 });

  await deleteProductionEvent(eventId, productionId);
  return Response.json({ ok: true });
}
