import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { canEditTechReq } from "@/lib/event-permissions";
import {
  getProductionEvent,
  getTechReqByProduction,
  isUserDeptPoc,
  listEventMilestoneIds,
  listEventTaskIds,
  setEventMilestones,
  updateTaskByProduction,
} from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await getProductionEvent(eventId, productionId)) return Response.json({ error: "事件不存在" }, { status: 404 });
  // 同目录 tech-reqs 的读门口径：事件详情 view 才看得到这个事件挂了什么
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "event", eventId, "details", "view")) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  const [taskIds, milestoneIds] = await Promise.all([
    listEventTaskIds(eventId, productionId),
    listEventMilestoneIds(eventId, productionId),
  ]);
  return Response.json({ taskIds, milestoneIds });
}

/**
 * 事件的关联面：里程碑 + 任务，全量覆盖写。
 *
 * 两组关联的门是**分开**的，不能用一枚 event details@edit 一把过：
 *  - 里程碑：event_milestone 是事件自己的属性，event/<id>/details@edit 即可。
 *  - 任务：改 task.event_id 是 **task 侧**的写入。主干 PATCH /tasks/[taskId] 对它是
 *    两道门（canEditTechReq 本体门 + 目标事件的 attach 资格门），本路由必须同口径，
 *    否则持某个事件 details@edit 的人就能把任意部门的独立任务抓进自己的事件——
 *    与 d9faa43「边键当本体键用」是同一类越权。
 *
 * 实际写入也走 updateTaskByProduction，不自己 UPDATE task：换绑 event 带三件连带
 * 动作（清 task_schedule_item、#236 形状 L 的孤儿处置），绕过它会留下不一致状态。
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { permCtx } = access;

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const actor = toActor(session, permCtx);
  if (!await hasEffectiveGrant(actor, productionId, "event", eventId, "details", "edit")) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json() as { taskIds?: unknown; milestoneIds?: unknown };
  const asIdList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === "string"))] : undefined;
  const nextTaskIds = asIdList(body.taskIds);
  const nextMilestoneIds = asIdList(body.milestoneIds);

  // 任务是全量覆盖语义，漏发 taskIds 会把整个事件的任务解绑干净——所以只有显式
  // 传了数组才动任务，缺字段 = 不动。
  let attach: string[] = [];
  let detach: string[] = [];
  if (nextTaskIds) {
    const current = await listEventTaskIds(eventId, productionId);
    attach = nextTaskIds.filter(id => !current.includes(id));
    detach = current.filter(id => !nextTaskIds.includes(id));
  }

  for (const taskId of [...detach, ...attach]) {
    const task = await getTechReqByProduction(taskId, productionId);
    if (!task) return Response.json({ error: "包含不存在的任务" }, { status: 400 });

    // 门 1（本体）：我能不能编辑这条任务。解绑的那批因为当前挂在本事件上，
    // canEditTechReq 里的 event details@edit 级联会放行；新增的独立任务不会。
    if (!await canEditTechReq(permCtx, taskId, task.eventId, productionId)) {
      return Response.json({ error: `对任务「${task.title || "未命名"}」没有编辑权` }, { status: 403 });
    }

    if (!attach.includes(taskId)) continue;

    if (task.eventId && task.eventId !== eventId) {
      return Response.json({ error: "任务已属于其他事件，请先在任务详情中解绑" }, { status: 400 });
    }
    // 门 2（挂载资格）：与 PATCH /tasks/[taskId] 换绑事件同口径
    const canAttach =
      await hasEffectiveGrant(actor, productionId, "event", eventId, "tasks", "create")
      || (task.departmentId != null
          && await isUserDeptPoc(task.departmentId, session.userId)
          && await hasEffectiveGrant(actor, productionId, "event", eventId, "details", "view"));
    if (!canAttach) {
      return Response.json({ error: "对本事件没有任务挂载资格" }, { status: 403 });
    }
  }

  try {
    for (const taskId of detach) await updateTaskByProduction(taskId, productionId, { eventId: null });
    for (const taskId of attach) await updateTaskByProduction(taskId, productionId, { eventId });
    if (nextMilestoneIds) await setEventMilestones(eventId, productionId, nextMilestoneIds);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存关联失败" }, { status: 400 });
  }

  const [taskIds, milestoneIds] = await Promise.all([
    listEventTaskIds(eventId, productionId),
    listEventMilestoneIds(eventId, productionId),
  ]);
  return Response.json({ ok: true, taskIds, milestoneIds });
}
