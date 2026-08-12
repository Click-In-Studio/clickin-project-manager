import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant, hasEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, listEventCallTimes, createEventCallTime } from "@/lib/event-db";
import { feishuPlatform } from "@/lib/platform/feishu";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `ct${Date.now().toString(36)}${(++_seq).toString(36)}`;

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

  const callTimes = await listEventCallTimes(eventId);
  return Response.json({ callTimes });
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
    userId?: string; name?: string; departmentId?: string | null;
    callAt?: string; scheduleItemId?: string | null; notes?: string;
  };
  if (!body.userId || !body.name || !body.callAt)
    return Response.json({ error: "userId、name、callAt 不能为空" }, { status: 400 });

  const callTime = await createEventCallTime({
    id: uid(),
    eventId,
    userId: body.userId,
    name: body.name,
    departmentId: body.departmentId ?? null,
    callAt: body.callAt,
    scheduleItemId: body.scheduleItemId ?? null,
    notes: body.notes ?? "",
  });

  if (event.chatId) {
    batchGetFeishuOpenIds([body.userId]).then(m => {
      const openId = m.get(body.userId!);
      if (openId) feishuPlatform.addGroupMembers(event.chatId!, [openId]).catch(console.error);
    }).catch(console.error);
  }

  return Response.json({ callTime }, { status: 201 });
}
