/**
 * POST /api/production/[id]/events/[eventId]/chat
 * Body: { action: "create" } | { action: "bind"; chatId: string }
 *
 * Create: builds a new Feishu group, names it "productionName - eventTitle",
 *   auto-adds operator + all participants + call-time people.
 * Bind: verifies operator is in the group and it's not a dept group,
 *   then records the chatId and adds the same set of people.
 *
 * Permission: event:create (same as creating events).
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getProductionEvent, setEventChatId, clearEventChatId, getEventChatTargets, getProductionDeptChatIds,
} from "@/lib/event-db";
import { createChat, addChatMembers, isUserInChat } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:create", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  if (event.chatId) return Response.json({ error: "事件群已存在" }, { status: 409 });

  const body = (await req.json()) as { action: "create" | "bind"; chatId?: string };

  const memberIds = await getEventChatTargets(eventId);
  const allIds = [...new Set([session.userId, ...memberIds])];

  let chatId: string;

  if (body.action === "create") {
    const productionName = await getProductionName(productionId);
    const chatName = `${productionName ?? "项目"} - ${event.title}`;
    const created = await createChat(chatName, session.userId, allIds);
    if (!created) return Response.json({ error: "飞书建群失败" }, { status: 502 });
    chatId = created;
  } else if (body.action === "bind") {
    if (!body.chatId) return Response.json({ error: "缺少 chatId" }, { status: 400 });

    const [inChat, deptChatIds] = await Promise.all([
      isUserInChat(body.chatId, session.userId),
      getProductionDeptChatIds(productionId),
    ]);
    if (!inChat) return Response.json({ error: "你不在该群中" }, { status: 403 });
    if (deptChatIds.has(body.chatId)) return Response.json({ error: "不能绑定部门群" }, { status: 400 });

    chatId = body.chatId;
    // Add people but do not purge
    await addChatMembers(chatId, allIds);
  } else {
    return Response.json({ error: "action 必须是 create 或 bind" }, { status: 400 });
  }

  await setEventChatId(eventId, chatId);
  return Response.json({ chatId });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:create", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  if (!event.chatId) return Response.json({ error: "事件群未绑定" }, { status: 409 });

  await clearEventChatId(eventId);
  return Response.json({ ok: true });
}
