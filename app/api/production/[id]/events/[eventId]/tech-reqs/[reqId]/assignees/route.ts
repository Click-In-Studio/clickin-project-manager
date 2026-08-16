import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, batchGetFeishuOpenIds } from "@/lib/db";
import { getProductionEvent, getEventTechReq, setTechReqAssignees } from "@/lib/event-db";
import { feishuPlatform } from "@/lib/platform/feishu";
import { canAssignTechReq } from "@/lib/event-permissions";
import { notifyTaskAssigned } from "@/lib/notify";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

/**
 * PUT — replace the assignee list for a tech requirement.
 * Body: { assignees: { userId: string; name: string }[] }
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const req_ = await getEventTechReq(reqId, eventId);
  if (!req_) return Response.json({ error: "技术需求不存在" }, { status: 404 });

  if (!await canAssignTechReq(permCtx, reqId, productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { assignees?: unknown };
  if (
    !Array.isArray(body.assignees) ||
    body.assignees.some(
      (x) =>
        typeof x !== "object" || x === null ||
        typeof (x as Record<string, unknown>).userId !== "string" ||
        typeof (x as Record<string, unknown>).name !== "string"
    )
  ) {
    return Response.json({ error: "assignees 必须是 { userId: string; name: string }[]" }, { status: 400 });
  }

  const prevAssignees = new Set(req_.assignees.map(a => a.userId));
  await setTechReqAssignees(reqId, body.assignees as { userId: string; name: string }[]);
  const updated = await getEventTechReq(reqId, eventId);

  const newUserIds = (body.assignees as { userId: string }[])
    .map(a => a.userId)
    .filter(id => !prevAssignees.has(id));

  if (newUserIds.length && updated) {
    // 指派通知（老板派活语义：纯告知，act=打开详情）
    void notifyTaskAssigned({
      productionId,
      taskId: reqId,
      taskTitle: updated.title,
      eventTitle: event.title,
      assignedBy: session.userId,
      userIds: newUserIds,
    }).catch(e => console.error("[task-assign] notify failed:", e));

    if (updated.chatId) {
      // Convert user_ids to Feishu open_ids for addChatMembers
      batchGetFeishuOpenIds(newUserIds).then(m => {
        const openIds = newUserIds.map(uid => m.get(uid)).filter((v): v is string => !!v);
        if (openIds.length) feishuPlatform.addGroupMembers(updated.chatId!, openIds).catch(console.error);
      }).catch(console.error);
    }
  }

  return Response.json({ techReq: updated });
}
