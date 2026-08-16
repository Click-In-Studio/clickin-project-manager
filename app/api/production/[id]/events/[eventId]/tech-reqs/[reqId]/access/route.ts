import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getEventTechReq } from "@/lib/event-db";
import {
  getTechReqAccess,
  selfConfirmResourceGrant,
  checkNodeFreeApprovalZone,
} from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!(await hasEventDomainView(toActor(session, access.permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const req_ = await getEventTechReq(reqId, eventId);
  if (!req_) return Response.json({ error: "不存在" }, { status: 404 });

  // owner/admin 旁路：三态判定只读授权行表，旁路语义必须在入口短路
  if (session.isAdmin || access.permCtx.isAdmin || access.permCtx.isOwner)
    return Response.json({ canAccess: true, level: "manage" });

  const result = await getTechReqAccess(session.userId, productionId, reqId);
  return Response.json(result);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reqId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!(await hasEventDomainView(toActor(session, permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const existingReq = await getEventTechReq(reqId, eventId);
  if (!existingReq) return Response.json({ error: "不存在" }, { status: 404 });

  const body = await req.json() as { action?: string; level?: string };
  if (body.action !== "self_confirm")
    return Response.json({ error: "未知操作" }, { status: 400 });

  const level = body.level as "edit" | "manage" | undefined;
  if (level !== "edit" && level !== "manage")
    return Response.json({ error: "无效的权限级别" }, { status: 400 });

  const inZone = await checkNodeFreeApprovalZone(
    session.userId, productionId, "task", reqId, level,
  );
  if (!inZone)
    return Response.json({ error: "不在免审批区间，无法自我确认" }, { status: 403 });

  await selfConfirmResourceGrant(session.userId, productionId, "task", reqId, level);
  return Response.json({ ok: true });
}
