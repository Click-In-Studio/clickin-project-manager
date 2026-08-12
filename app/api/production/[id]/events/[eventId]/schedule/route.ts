import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant, hasEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, listScheduleItems, createScheduleItem, setScheduleItemDepartments } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `si${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const items = await listScheduleItems(eventId);
  return Response.json({ items });
}

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

  if (!await hasEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", eventId, event.status === "published" ? "publication" : "details", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; itemType?: string; startTime?: string | null;
    endTime?: string | null; location?: string; orderIndex?: number;
    targetSceneId?: string | null; targetBlockId?: string | null; notes?: string;
    departmentIds?: string[];
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });

  const item = await createScheduleItem({
    id: uid(),
    eventId,
    title,
    itemType: body.itemType ?? "custom",
    startTime: body.startTime ?? null,
    endTime: body.endTime ?? null,
    location: body.location ?? "",
    orderIndex: body.orderIndex ?? 0,
    targetSceneId: body.targetSceneId ?? null,
    targetBlockId: body.targetBlockId ?? null,
    notes: body.notes ?? "",
  });
  if (body.departmentIds?.length) {
    await setScheduleItemDepartments(item.id, body.departmentIds);
  }
  return Response.json({ item }, { status: 201 });
}
