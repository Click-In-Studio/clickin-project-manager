import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getEventReport } from "@/lib/event-db";
import {
  getReportAccess,
  selfConfirmResourceGrant,
  checkNodeFreeApprovalZone,
} from "@/lib/resource-grant-db";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!(await hasEventDomainView(toActor(session, access.permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "不存在" }, { status: 404 });

  const result = await getReportAccess(session.userId, productionId, reportId);
  return Response.json(result);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
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
  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "不存在" }, { status: 404 });

  const body = await req.json() as { action?: string; level?: string };
  if (body.action !== "self_confirm")
    return Response.json({ error: "未知操作" }, { status: 400 });

  const level = body.level as "edit" | "manage" | undefined;
  if (level !== "edit" && level !== "manage")
    return Response.json({ error: "无效的权限级别" }, { status: 400 });

  // 区间判定与 GET 的 getReportAccess 同源（checkNodeFreeApprovalZone）：
  // 旧的 checkResourceFreeApprovalZone 查 dept.permissions 数组 + 伪键 'report:edit'，
  // 两者都已退役（批C 清伪键、PR #229 DROP 该列）——GET 说"可自我确认"、POST 却 500。
  const inZone = await checkNodeFreeApprovalZone(
    session.userId, productionId, "report", reportId, level,
  );
  if (!inZone)
    return Response.json({ error: "不在免审批区间，无法自我确认" }, { status: 403 });

  await selfConfirmResourceGrant(session.userId, productionId, "report", reportId, level);
  return Response.json({ ok: true });
}
