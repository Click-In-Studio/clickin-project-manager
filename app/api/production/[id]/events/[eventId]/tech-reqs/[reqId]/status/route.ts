import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant, hasEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, getEventTechReq, updateEventTechReq, isUserReqAssignee, isUserDeptPoc } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

const VALID_STATUSES = new Set(["awaiting", "pending", "in_progress", "done"]);

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const existing = await getEventTechReq(reqId, eventId);
  if (!existing) return Response.json({ error: "技术需求不存在" }, { status: 404 });

  const { status } = (await req.json()) as { status?: string };
  if (!status || !VALID_STATUSES.has(status))
    return Response.json({ error: "无效 status" }, { status: 400 });

  const hasFullEdit =
    await hasEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", eventId, "details", "edit")
    || await hasEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "task", "*", "*", "edit");
  // Only full-editors can set back to awaiting
  if (status === "awaiting" && !hasFullEdit)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const [isAssignee, isPoc] = await Promise.all([
    isUserReqAssignee(reqId, session.userId),
    existing.departmentId ? isUserDeptPoc(existing.departmentId, session.userId) : Promise.resolve(false),
  ]);
  if (!isAssignee && !isPoc && !hasFullEdit)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const updated = await updateEventTechReq(reqId, eventId, { status });
  return Response.json({ techReq: updated });
}
