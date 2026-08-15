import { type NextRequest } from "next/server";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import {
  deleteTaskByProduction,
  getProductionEvent,
  getTaskDependencies,
  getTechReqByProduction,
  isUserDeptPoc,
  updateTaskByProduction,
} from "@/lib/event-db";
import { canEditTechReq, canViewTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, taskId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;

  const task = await getTechReqByProduction(taskId, productionId);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });

  if (!await canViewTechReq(permCtx, taskId, task.eventId, productionId, task.departmentId, { participantDeptIds: [] }))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const dependencies = await getTaskDependencies(taskId);
  return Response.json({ task, ...dependencies });
}

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

  if (!await canEditTechReq(permCtx, taskId, existing.eventId, productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; description?: string;
    presetMinutes?: number | null; departmentId?: string | null; status?: string;
    startTime?: string | null; endTime?: string | null;
    eventId?: string | null;
  };

  // 换绑事件 = 对目标 event 的 attach 操作，同创建时的挂载资格门
  // （event tasks@create，或 POC 路径：任务绑我 POC 的部门 + 目标 event details@view）。
  // 解绑（null）与保持不变不查
  if (body.eventId !== undefined && body.eventId !== null && body.eventId !== existing.eventId) {
    const targetEvent = await getProductionEvent(body.eventId, productionId);
    if (!targetEvent) return Response.json({ error: "目标事件不存在" }, { status: 400 });
    const actor = toActor(session, permCtx);
    const canAttach =
      await hasEffectiveGrant(actor, productionId, "event", body.eventId, "tasks", "create")
      || (existing.departmentId != null
          && await isUserDeptPoc(existing.departmentId, session.userId)
          && await hasEffectiveGrant(actor, productionId, "event", body.eventId, "details", "view"));
    if (!canAttach)
      return Response.json({ error: "对目标事件没有任务挂载资格" }, { status: 403 });
  }

  try {
    const updated = await updateTaskByProduction(taskId, productionId, {
      title: body.title?.trim(),
      description: body.description,
      presetMinutes: body.presetMinutes,
      departmentId: body.departmentId,
      status: body.status,
      startTime: body.startTime,
      endTime: body.endTime,
      eventId: body.eventId,
    });
    return Response.json({ task: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "更新失败";
    if (msg.includes("跨剧组") || msg.includes("不存在") || msg.includes("task_time_order_check"))
      return Response.json({ error: msg }, { status: 400 });
    throw err;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, taskId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const task = await getTechReqByProduction(taskId, productionId);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });

  const canDelete =
    await hasEffectiveGrant(toActor(session, permCtx), productionId, "task", taskId, "*", "delete")
    || (task.eventId != null
        && await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", task.eventId, "tasks", "delete"))
    // 删除权按创建路径区分（用户规范）：organizer 显式创建的 task，部门 POC 无自动
    // 删除权；dept_auto（关联部门自动创建）路径的 POC 恒可删（上下文判定）
    || (task.createdVia !== "explicit" && task.departmentId != null
        && await isUserDeptPoc(task.departmentId, session.userId));
  if (!canDelete)
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteTaskByProduction(taskId, productionId);
  return Response.json({ ok: true });
}
