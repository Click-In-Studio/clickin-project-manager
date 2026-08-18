import { type NextRequest } from "next/server";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getEventReport, updateEventReport, deleteEventReport } from "@/lib/event-db";
import { canWriteReport, canPublishReport } from "@/lib/event-permissions";
import { dispatchReportNotification, dispatchMentionNotifications } from "@/lib/notify";
import type { Mention } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const existing = await getEventReport(reportId, eventId);
  if (!existing) return Response.json({ error: "记录不存在" }, { status: 404 });

  if (!await canWriteReport(permCtx, reportId, productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    reportType?: string; title?: string; body?: string;
    publishedAt?: string | null; mentions?: Mention[];
  };

  // Publishing requires publish-level grant
  if (body.publishedAt !== undefined && !await canPublishReport(permCtx, reportId, productionId))
    return Response.json({ error: "权限不足：发布需要更高级别授权" }, { status: 403 });

  const updated = await updateEventReport(reportId, eventId, {
    reportType: body.reportType,
    title: body.title?.trim(),
    body: body.body,
    publishedAt: body.publishedAt,
    mentions: body.mentions,
  });

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
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  // #236 张力 4a：同 event，本门此前查 `grants@edit` 使 delete 成为死动词。
  // 注意删的是**边**不是文档（M-15(b)）：deleteEventReport 解除挂载，wiki 本体仍在，
  // 定式 C-7 会给作者补发 wiki manage 防失访。
  // 默认持钥人＝舞监（add-report-delete-to-stage-managers.sql 补的模板行）；
  // 创建者要不要有，由策略键 report.creator:*@delete 决定（默认关）。
  if (!await hasEffectiveGrant(toActor(session, permCtx), productionId, "report", reportId, "*", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  await deleteEventReport(reportId, eventId);
  return Response.json({ ok: true });
}
