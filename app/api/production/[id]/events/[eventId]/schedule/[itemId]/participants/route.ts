import { type NextRequest } from "next/server";
import { hasEventContentEdit } from "@/lib/event-permissions";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getScheduleItem, setScheduleItemParticipants } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string; itemId: string }> };

/**
 * PUT — replace the participant list for a schedule item.
 * Body: { participants: { userId: string; name: string }[] }
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, itemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const item = await getScheduleItem(itemId, eventId);

  if (!await hasEventContentEdit(toActor(session, permCtx), productionId, eventId, event.status))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (!item) return Response.json({ error: "流程项不存在" }, { status: 404 });

  const body = (await req.json()) as { participants?: unknown };
  if (
    !Array.isArray(body.participants) ||
    body.participants.some(
      (x) =>
        typeof x !== "object" || x === null ||
        typeof (x as Record<string, unknown>).userId !== "string" ||
        typeof (x as Record<string, unknown>).name !== "string"
    )
  ) {
    return Response.json({ error: "participants 必须是 { userId: string; name: string }[]" }, { status: 400 });
  }

  await setScheduleItemParticipants(itemId, body.participants as { userId: string; name: string }[]);
  return Response.json({ ok: true });
}
