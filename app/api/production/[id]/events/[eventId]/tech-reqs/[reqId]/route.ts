import { type NextRequest } from "next/server";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getEventTechReq, updateTaskByProduction, deleteTaskByProduction } from "@/lib/event-db";
import { isTaskPoc, resolveSubjectPatch } from "@/lib/task-poc";
import { canEditTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const existing = await getEventTechReq(reqId, eventId);
  if (!existing) return Response.json({ error: "技术需求不存在" }, { status: 404 });

  if (!await canEditTechReq(permCtx, reqId, eventId, productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; description?: string;
    presetMinutes?: number | null; departmentId?: string | null; groupId?: string | null;
    status?: string;
  };

  // 换责任主体（部门 ↔ 用户组）。都没给 = 不动；每个字段只清它自己那一支：departmentId: null 不会顺手把用户组也解绑。
  // 旧客户端（任务抽屉）不知道有组，绑组的 task 在它那里 departmentId 是空，
  // 提交时发 null——按「重设整个主体」处理的话，点一下保存就把组吃掉了。
  const patch = await resolveSubjectPatch(productionId, body, {
    departmentId: existing.departmentId, groupId: existing.groupId,
  });
  if (!patch.ok) return Response.json({ error: patch.error }, { status: patch.status });
  const subjectCols = patch.cols;

  const updated = await updateTaskByProduction(reqId, productionId, {
    title: body.title?.trim(),
    description: body.description,
    presetMinutes: body.presetMinutes,
    ...(subjectCols ?? {}),
    status: body.status,
  });
  return Response.json({ techReq: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const techReq = await getEventTechReq(reqId, eventId);
  // 边/本体删除单调性（M-15(d)）：本路由虽挂在 event 路径下，动作仍是**硬删 task 本体**
  // （deleteTaskByProduction），故只认本体键。`event/<id>/tasks@delete` 是边键（摘边），
  // 曾并进本门 → organizer 能硬删部门的 task，与「指派面独立」定谳冲突。
  // 摘边走 PATCH /tasks/<id> { eventId: null }。
  const canDelete =
    await hasEffectiveGrant(toActor(session, permCtx), productionId, "task", reqId, "*", "delete")
    // 删除权按创建路径区分（用户规范）：organizer 显式创建的 task，部门 POC 无自动
    // 删除权；dept_auto（关联部门自动创建）路径的 POC 恒可删（上下文判定）
    || (techReq != null && techReq.createdVia !== "explicit" && techReq.departmentId != null
        && await isTaskPoc(productionId, techReq, session.userId));
  if (!canDelete)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  await deleteTaskByProduction(reqId, productionId);
  return Response.json({ ok: true });
}
