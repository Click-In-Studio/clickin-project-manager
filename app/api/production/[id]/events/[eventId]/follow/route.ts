import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, selfFollowEvent, selfUnfollowEvent, getSelfParticipantRole } from "@/lib/event-db";
import { addChatMembers } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  await selfFollowEvent(eventId, session.userId, session.name);
  const role = await getSelfParticipantRole(eventId, session.userId);

  if (event.chatId) {
    addChatMembers(event.chatId, [session.userId]).catch(console.error);
  }

  return Response.json({ role });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  await selfUnfollowEvent(eventId, session.userId);
  return Response.json({ role: null });
}
