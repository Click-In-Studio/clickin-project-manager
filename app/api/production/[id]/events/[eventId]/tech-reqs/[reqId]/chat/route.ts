/**
 * POST /api/production/[id]/events/[eventId]/tech-reqs/[reqId]/chat
 * Body: { action: "create" } | { action: "bind"; chatId: string }
 *
 * Create: builds a new Feishu group, names it "productionName - eventTitle - reqTitle",
 *   auto-adds operator + req assignees + dept POCs.
 * Bind: verifies operator is in the group and it's not a dept group,
 *   then records the chatId and adds the same set of people.
 *
 * Permission: POC of the req's dept OR event:tech_req_delete (same as creating reqs).
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getProductionEvent, getEventTechReq, setTechReqChatId,
  getReqChatTargets, getProductionDeptChatIds, isUserDeptPoc,
} from "@/lib/event-db";
import { createChat, addChatMembers, isUserInChat } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);

  const [event, techReq] = await Promise.all([
    getProductionEvent(eventId, productionId),
    getEventTechReq(reqId, eventId),
  ]);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  if (!techReq) return Response.json({ error: "需求不存在" }, { status: 404 });
  if (techReq.chatId) return Response.json({ error: "需求群已存在" }, { status: 409 });

  const isPoc = techReq.departmentId
    ? await isUserDeptPoc(techReq.departmentId, session.openId)
    : false;
  const canManage = hasPermission("event:tech_req_delete", session.isAdmin, memberRoles, overrides) || isPoc;
  if (!canManage) return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { action: "create" | "bind"; chatId?: string };

  const memberIds = await getReqChatTargets(reqId);
  const allIds = [...new Set([session.openId, ...memberIds])];

  let chatId: string;

  if (body.action === "create") {
    const productionName = await getProductionName(productionId);
    const chatName = `${productionName ?? "项目"} - ${event.title} - ${techReq.title || "需求"}`;
    const created = await createChat(chatName, session.openId, allIds);
    if (!created) return Response.json({ error: "飞书建群失败" }, { status: 502 });
    chatId = created;
  } else if (body.action === "bind") {
    if (!body.chatId) return Response.json({ error: "缺少 chatId" }, { status: 400 });

    const [inChat, deptChatIds] = await Promise.all([
      isUserInChat(body.chatId, session.openId),
      getProductionDeptChatIds(productionId),
    ]);
    if (!inChat) return Response.json({ error: "你不在该群中" }, { status: 403 });
    if (deptChatIds.has(body.chatId)) return Response.json({ error: "不能绑定部门群" }, { status: 400 });

    chatId = body.chatId;
    await addChatMembers(chatId, allIds);
  } else {
    return Response.json({ error: "action 必须是 create 或 bind" }, { status: 400 });
  }

  await setTechReqChatId(reqId, chatId);
  return Response.json({ chatId });
}
