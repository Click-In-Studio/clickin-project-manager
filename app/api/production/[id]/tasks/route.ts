import { type NextRequest } from "next/server";
import { canAccessNode } from "@/lib/grant-template";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { notifyTaskAssigned } from "@/lib/notify";
import { isDeptSubjectPoc } from "@/lib/task-poc";
import {
  createEventTechReq,
  getEventDepartment,
  getProductionEvent,
  listMyTechReqsFull,
  listProductionTechReqs,
} from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `tr${Date.now().toString(36)}${(++_seq).toString(36)}`;

/** GET — production 级任务列表。全量视图需 task/*@view，否则退化为与我相关的任务。 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;

  const canViewAll = await hasEffectiveGrant(toActor(session, permCtx), productionId, "task", "*", "*", "view");
  if (canViewAll) {
    const tasks = await listProductionTechReqs(productionId);
    return Response.json({ tasks, full: true });
  }
  const tasks = (await listMyTechReqsFull(session.userId)).filter(t => t.productionId === productionId);
  return Response.json({ tasks, full: false });
}

/**
 * POST — 创建任务（event 绑定可选）。
 * 绑定 event：沿用 attach 语义（event:tasks@create 或 POC 路径三）。
 * 无绑定：集合级 node:task/*@create。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; description?: string;
    eventId?: string | null; scheduleItemIds?: string[];
    presetMinutes?: number | null; departmentId?: string | null;
    assignees?: { userId: string; name: string }[];
    startTime?: string | null; endTime?: string | null;
    milestoneIds?: string[];
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });
  const eventId = body.eventId ?? null;

  // departmentId 必须属于本 production——POC 判定已自带 production 作用域，
  // 这道校验留着是为了回更准的 400「部门不存在」，并挡住绑入跨剧组部门
  if (typeof body.departmentId === "string"
      && !(await getEventDepartment(body.departmentId, productionId)))
    return Response.json({ error: "部门不存在" }, { status: 400 });

  let viaPoc = false;
  if (eventId) {
    const event = await getProductionEvent(eventId, productionId);
    if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
    // 路径三（部门 POC 对可见 event 主动发起本部门 task）：前提是对该 event 有 details 视图
    viaPoc = typeof body.departmentId === "string"
      && await isDeptSubjectPoc(productionId, body.departmentId, session.userId)
      && await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "details", "view");
    if (!viaPoc
        && !await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "tasks", "create"))
      return Response.json({ error: "权限不足" }, { status: 403 });
  } else {
    if (body.scheduleItemIds?.length)
      return Response.json({ error: "绑定 schedule item 需要先绑定 event" }, { status: 400 });
    const createAccess = await canAccessNode(permCtx, productionId, "task", "*", "*", "create");
    if (!createAccess.allowed)
      return Response.json({ error: "权限不足" }, { status: 403 });
  }

  if (body.startTime && body.endTime && new Date(body.endTime) < new Date(body.startTime))
    return Response.json({ error: "结束时间不能早于开始时间" }, { status: 400 });

  // 创建即指派同受指派面约束（与 PUT /assignees 同门）：task 通配 assignees@edit，
  // 或所绑部门的 POC。无资格 ⇒ 发给部门待 POC 分配，不能直接点名
  if ((body.assignees?.length ?? 0) > 0) {
    const canDirectAssign =
      await hasEffectiveGrant(toActor(session, permCtx), productionId, "task", "*", "assignees", "edit")
      || (typeof body.departmentId === "string"
          && await isDeptSubjectPoc(productionId, body.departmentId, session.userId));
    if (!canDirectAssign)
      return Response.json({ error: "你没有直接指派的权限——请绑定部门后交由部门 POC 分配" }, { status: 403 });
  }

  const techReq = await createEventTechReq({
    id: uid(),
    productionId,
    eventId,
    scheduleItemIds: body.scheduleItemIds ?? [],
    title,
    description: body.description ?? "",
    presetMinutes: body.presetMinutes ?? null,
    departmentId: body.departmentId ?? null,
    assignees: body.assignees ?? [],
    startTime: body.startTime ?? null,
    endTime: body.endTime ?? null,
    milestoneIds: body.milestoneIds ?? [],
    createdBy: session.userId,
    createdVia: viaPoc ? "poc" : "explicit",
  });

  // 创建即指派 → 指派通知（老板派活语义：纯告知，act=打开详情）
  if (techReq.assignees.length > 0) {
    const event = eventId ? await getProductionEvent(eventId, productionId) : null;
    void notifyTaskAssigned({
      productionId,
      taskId: techReq.id,
      taskTitle: techReq.title,
      eventTitle: event?.title ?? null,
      assignedBy: session.userId,
      userIds: techReq.assignees.map(a => a.userId),
    }).catch(e => console.error("[task-assign] notify failed:", e));
  }

  return Response.json({ task: techReq }, { status: 201 });
}
