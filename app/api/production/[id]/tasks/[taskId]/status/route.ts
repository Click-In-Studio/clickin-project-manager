import { type NextRequest } from "next/server";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getTechReqByProduction, updateTaskByProduction, isUserReqAssignee, isUserDeptPoc } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

const VALID_STATUSES = new Set(["awaiting", "pending", "in_progress", "done"]);

/** PATCH — 推进任务状态。assignee/POC 可推进；回退 awaiting 需全量编辑权。 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, taskId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getTechReqByProduction(taskId, productionId);
  if (!existing) return Response.json({ error: "任务不存在" }, { status: 404 });

  const { status } = (await req.json()) as { status?: string };
  if (!status || !VALID_STATUSES.has(status))
    return Response.json({ error: "无效 status" }, { status: 400 });

  const hasFullEdit =
    (existing.eventId != null
      && await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", existing.eventId, "details", "edit"))
    || await hasEffectiveGrant(toActor(session, permCtx), productionId, "task", "*", "*", "edit");
  // Only full-editors can set back to awaiting
  if (status === "awaiting" && !hasFullEdit)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const [isAssignee, isPoc] = await Promise.all([
    isUserReqAssignee(taskId, session.userId),
    existing.departmentId ? isUserDeptPoc(existing.departmentId, session.userId) : Promise.resolve(false),
  ]);
  if (!isAssignee && !isPoc && !hasFullEdit)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const updated = await updateTaskByProduction(taskId, productionId, { status });
  return Response.json({ task: updated });
}
