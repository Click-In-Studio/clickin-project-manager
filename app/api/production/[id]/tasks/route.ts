import { type NextRequest } from "next/server";
import { canAccessNode } from "@/lib/grant-template";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import {
  createEventTechReq,
  getProductionEvent,
  isUserDeptPoc,
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

  let viaPoc = false;
  if (eventId) {
    const event = await getProductionEvent(eventId, productionId);
    if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
    // 路径三（部门 POC 对可见 event 主动发起本部门 task）：前提是对该 event 有 details 视图
    viaPoc = typeof body.departmentId === "string"
      && await isUserDeptPoc(body.departmentId, session.userId)
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

  return Response.json({ task: techReq }, { status: 201 });
}
