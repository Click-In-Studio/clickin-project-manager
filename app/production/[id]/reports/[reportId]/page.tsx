import type { Metadata } from "next";
import { hasGrant, toActor } from "@/lib/grant-check";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { getProductionPermissionContext, listProductionMembers } from "@/lib/db";
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
  canModerateNotes, isReportViewer,
  canReplyToReport,
  hasEventDomainView,
} from "@/lib/event-permissions";
import { hasResourceGrantLevel } from "@/lib/resource-grant-db";
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
  if (!_prodAccess) redirect(`/unauthorized?id=${productionId}`);
  const { permCtx: prodPermCtx } = _prodAccess;
  if (!(await hasEventDomainView(toActor(session, prodPermCtx), productionId))) redirect(`/unauthorized?resource=event%3Afollow&id=${productionId}`);

  const report = await getReportByProduction(reportId, productionId);
  if (!report) notFound();

  const eventId = report.eventId;
  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  const canViewReportUnpublished = await isReportViewer(prodPermCtx, productionId)
    || await hasGrant(session.userId, productionId, "event", eventId, "reports", "view")
    || await hasResourceGrantLevel(session.userId, productionId, "report", reportId, "view");

  if (!canViewReportUnpublished && !VISIBLE_STATUSES.has(event.status))
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

  // Page-level: can write note for at least one dept (specific dept check is in POST /notes)
  const userCanWriteNote = prodPermCtx.isAdmin
    || eventPermCtx.participantDeptIds.length > 0
    || await canModerateNotes(prodPermCtx, productionId, eventId);
  const userCanModerate = await canModerateNotes(prodPermCtx, productionId, eventId);
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
