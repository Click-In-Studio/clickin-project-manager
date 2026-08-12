import { type NextRequest } from "next/server";
import { hasEventContentEdit } from "@/lib/event-permissions";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, reorderScheduleItems } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
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

  const body = (await req.json()) as { orderedIds?: unknown };
  if (!Array.isArray(body.orderedIds) || body.orderedIds.some(x => typeof x !== "string"))
    return Response.json({ error: "orderedIds 必须是 string[]" }, { status: 400 });

  await reorderScheduleItems(eventId, body.orderedIds as string[]);
  return Response.json({ ok: true });
}
