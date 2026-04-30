import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listScheduleItems, createScheduleItem, setScheduleItemDepartments } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `si${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
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
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:schedule_edit", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

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
