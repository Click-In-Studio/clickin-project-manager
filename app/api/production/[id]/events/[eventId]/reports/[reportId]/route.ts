import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, getEventReport, updateEventReport, deleteEventReport } from "@/lib/event-db";
import { loadEventPermContext, canWriteReport } from "@/lib/event-permissions";
import { dispatchReportNotification, dispatchMentionNotifications } from "@/lib/notify";
import type { Mention } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const existing = await getEventReport(reportId, eventId);
  if (!existing) return Response.json({ error: "记录不存在" }, { status: 404 });

  const permCtx = await loadEventPermContext(session.openId, eventId);
  if (!canWriteReport(session.isAdmin, memberRoles, overrides, permCtx))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    reportType?: string; title?: string; body?: string;
    publishedAt?: string | null; mentions?: Mention[];
  };

  const updated = await updateEventReport(reportId, eventId, {
    reportType: body.reportType,
    title: body.title?.trim(),
    body: body.body,
    publishedAt: body.publishedAt,
    mentions: body.mentions,
  });

  // On publish: broadcast to all followers + send mention notifications
  if (body.publishedAt && !existing.publishedAt && updated) {
    dispatchReportNotification(reportId, eventId, productionId).catch(e =>
      console.error("[notify] dispatchReportNotification failed:", e),
    );
    dispatchMentionNotifications(reportId, eventId, productionId).catch(e =>
      console.error("[notify] dispatchMentionNotifications failed:", e),
    );
  }

  return Response.json({ report: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:publish", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  await deleteEventReport(reportId, eventId);
  return Response.json({ ok: true });
}
