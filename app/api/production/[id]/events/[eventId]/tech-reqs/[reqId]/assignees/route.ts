import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { getProductionEvent, getEventTechReq, setTechReqAssignees } from "@/lib/event-db";
import { addChatMembers } from "@/lib/feishu-chat";
import { loadEventPermContext, canAssignTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

/**
 * PUT — replace the assignee list for a tech requirement.
 * Body: { assignees: { openId: string; name: string }[] }
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const req_ = await getEventTechReq(reqId, eventId);
  if (!req_) return Response.json({ error: "技术需求不存在" }, { status: 404 });

  const permCtx = await loadEventPermContext(session.openId, eventId);
  if (!canAssignTechReq(session.isAdmin, memberRoles, overrides, permCtx, req_.departmentId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { assignees?: unknown };
  if (
    !Array.isArray(body.assignees) ||
    body.assignees.some(
      (x) =>
        typeof x !== "object" || x === null ||
        typeof (x as Record<string, unknown>).openId !== "string" ||
        typeof (x as Record<string, unknown>).name !== "string"
    )
  ) {
    return Response.json({ error: "assignees 必须是 { openId: string; name: string }[]" }, { status: 400 });
  }

  const prevAssignees = new Set(req_.assignees.map(a => a.openId));
  await setTechReqAssignees(reqId, body.assignees as { openId: string; name: string }[]);
  const updated = await getEventTechReq(reqId, eventId);

  if (updated?.chatId) {
    const newIds = (body.assignees as { openId: string }[])
      .map(a => a.openId)
      .filter(id => !prevAssignees.has(id));
    if (newIds.length) addChatMembers(updated.chatId, newIds).catch(console.error);
  }

  return Response.json({ techReq: updated });
}
