import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listEventCallTimes, createEventCallTime } from "@/lib/event-db";
import { addChatMembers } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `ct${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
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
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:call_edit", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as {
    openId?: string; name?: string; departmentId?: string | null;
    callAt?: string; scheduleItemId?: string | null; notes?: string;
  };
  if (!body.openId || !body.name || !body.callAt)
    return Response.json({ error: "openId、name、callAt 不能为空" }, { status: 400 });

  const callTime = await createEventCallTime({
    id: uid(),
    eventId,
    openId: body.openId,
    name: body.name,
    departmentId: body.departmentId ?? null,
    callAt: body.callAt,
    scheduleItemId: body.scheduleItemId ?? null,
    notes: body.notes ?? "",
  });

  if (event.chatId) {
    addChatMembers(event.chatId, [body.openId]).catch(console.error);
  }

  return Response.json({ callTime }, { status: 201 });
}
