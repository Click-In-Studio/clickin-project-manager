import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { getProductionPermissionContext, listProductionMembers } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import {
  getReportByProduction,
  getProductionEvent,
  listReportNotes,
  listReportReplies,
  listEventDepartments,
  markReportRead,
} from "@/lib/event-db";
import {
  loadEventPermContext,
  canWriteNote, canModerateNotes, isReportViewer,
  canReplyToReport,
} from "@/lib/event-permissions";
import ReportViewClient from "@/components/ReportViewClient";

export async function generateMetadata({ params }: { params: Promise<{ id: string; reportId: string }> }): Promise<Metadata> {
  const { id: productionId, reportId } = await params;
  const report = await getReportByProduction(reportId, productionId);
  return { title: report?.title ?? "报告" };
}

type Ctx = {
  params: Promise<{ id: string; reportId: string }>;
  searchParams: Promise<{ t?: string }>;
};

const VISIBLE_STATUSES = new Set(["published", "completed"]);

export default async function ReportViewPage({ params, searchParams }: Ctx) {
  const { id: productionId, reportId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const { t: tokenParam } = await searchParams;

  if (!session) {
    const tokenData = tokenParam
      ? verifyCardToken(tokenParam, `report:${reportId}`)
      : null;
    if (!tokenData) redirect("/login");

    const report = await getReportByProduction(reportId, productionId);
    if (!report || !report.publishedAt) notFound();

    const eventId = report.eventId;
    const [event, notes, departments, replies, allMembers] = await Promise.all([
      getProductionEvent(eventId, productionId),
      listReportNotes(reportId),
      listEventDepartments(productionId),
      listReportReplies(reportId),
      listProductionMembers(productionId),
    ]);
    if (!event) notFound();

    await markReportRead(reportId, tokenData.userId);

    return (
      <ReportViewClient
        productionId={productionId}
        eventId={eventId}
        event={event}
        report={report}
        notes={notes}
        departments={departments.filter(d => d.kind === "dept")}
        canWriteNote={false}
        canModerateNotes={false}
        currentUserId={tokenData.userId}
        isPublished={true}
        replies={replies}
        canReply={false}
        memberDeptIds={[]}
        members={allMembers.map(m => ({ openId: m.openId, userId: m.userId, name: m.name }))}
      />
    );
  }

  const _prodAccess = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!_prodAccess) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${productionId}`);
  const { permCtx: prodPermCtx } = _prodAccess;
  if (!hasPermission("event:follow", prodPermCtx)) redirect(`/unauthorized?resource=${encodeURIComponent("项目演出报告")}&id=${productionId}`);

  const report = await getReportByProduction(reportId, productionId);
  if (!report) notFound();

  const eventId = report.eventId;
  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  const canViewFull = hasPermission("event:edit", prodPermCtx);
  const canViewReportUnpublished = isReportViewer(prodPermCtx);

  if (!canViewFull && !canViewReportUnpublished && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/reports`);

  if (!report.publishedAt && !canViewReportUnpublished)
    redirect(`/production/${productionId}/reports`);

  const eventPermCtx = await loadEventPermContext(session.userId, eventId);

  const [notes, departments, replies, allMembers] = await Promise.all([
    listReportNotes(reportId),
    listEventDepartments(productionId),
    listReportReplies(reportId),
    listProductionMembers(productionId),
  ]);

  if (report.publishedAt) {
    await markReportRead(reportId, session.userId);
  }

  const userCanWriteNote = canWriteNote(prodPermCtx, eventPermCtx);
  const userCanModerate = canModerateNotes(prodPermCtx);
  const userCanReply = canReplyToReport(session.isAdmin, eventPermCtx.isFollower, eventPermCtx.isInCall);

  return (
    <ReportViewClient
      productionId={productionId}
      eventId={eventId}
      event={event}
      report={report}
      notes={notes}
      departments={departments.filter(d => d.kind === "dept")}
      canWriteNote={userCanWriteNote}
      canModerateNotes={userCanModerate}
      currentUserId={session.userId}
      isPublished={!!report.publishedAt}
      replies={replies}
      canReply={userCanReply}
      memberDeptIds={eventPermCtx.memberDeptIds}
      members={allMembers.map(m => ({ openId: m.openId, userId: m.userId, name: m.name }))}
    />
  );
}
