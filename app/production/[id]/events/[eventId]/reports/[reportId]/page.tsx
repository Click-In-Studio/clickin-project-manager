import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getProductionEvent,
  getEventReport,
  listReportNotes,
  listReportReplies,
  listEventDepartments,
  markReportRead,
} from "@/lib/event-db";
import {
  loadEventPermContext,
  canWriteNote, canModerateNotes, REPORT_VIEWER_ROLES,
  canReplyToReport,
} from "@/lib/event-permissions";
import ReportViewClient from "@/components/ReportViewClient";

export async function generateMetadata({ params }: { params: Promise<{ eventId: string; reportId: string }> }): Promise<Metadata> {
  const { eventId, reportId } = await params;
  const report = await getEventReport(reportId, eventId);
  return { title: report?.title ?? "演出报告" };
}

type Ctx = {
  params: Promise<{ id: string; eventId: string; reportId: string }>;
  searchParams: Promise<{ t?: string }>;
};

const VISIBLE_STATUSES = new Set(["published", "completed"]);

export default async function ReportViewPage({ params, searchParams }: Ctx) {
  const { id: productionId, eventId, reportId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const { t: tokenParam } = await searchParams;

  // Token mode: card link with embedded openId, view-only, no permission checks
  if (!session) {
    const tokenData = tokenParam
      ? verifyCardToken(tokenParam, `report:${reportId}`)
      : null;
    if (!tokenData) redirect("/login");

    const event = await getProductionEvent(eventId, productionId);
    if (!event) redirect(`/production/${productionId}/events`);

    const report = await getEventReport(reportId, eventId);
    if (!report || !report.publishedAt) redirect("/login");

    const [notes, departments, replies] = await Promise.all([
      listReportNotes(reportId),
      listEventDepartments(productionId),
      listReportReplies(reportId),
    ]);

    await markReportRead(reportId, tokenData.openId);

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
        currentUserOpenId={tokenData.openId}
        isPublished={true}
        replies={replies}
        canReply={false}
        memberDeptIds={[]}
      />
    );
  }

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides)) redirect("/");

  const event = await getProductionEvent(eventId, productionId);
  if (!event) redirect(`/production/${productionId}/events`);

  const canViewFull = hasPermission("event:view_full", session.isAdmin, memberRoles, overrides);
  const isReportViewer = session.isAdmin || memberRoles?.some(r => REPORT_VIEWER_ROLES.has(r)) || false;

  // Event visibility: directors/SM can see draft events; others need published/completed
  if (!canViewFull && !isReportViewer && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/events`);

  const report = await getEventReport(reportId, eventId);
  if (!report) redirect(`/production/${productionId}/events/${eventId}/view`);

  // Report visibility: published for everyone; unpublished only for SM/director roles
  if (!report.publishedAt && !isReportViewer)
    redirect(`/production/${productionId}/events/${eventId}/view`);

  const permCtx = await loadEventPermContext(session.openId, eventId);

  const [notes, departments, replies] = await Promise.all([
    listReportNotes(reportId),
    listEventDepartments(productionId),
    listReportReplies(reportId),
  ]);

  if (report.publishedAt) {
    await markReportRead(reportId, session.openId);
  }

  const userCanWriteNote = canWriteNote(session.isAdmin, memberRoles, permCtx);
  const userCanModerate = canModerateNotes(session.isAdmin, memberRoles);
  const userCanReply = canReplyToReport(session.isAdmin, permCtx.isFollower, permCtx.isInCall);

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
      currentUserOpenId={session.openId}
      isPublished={!!report.publishedAt}
      replies={replies}
      canReply={userCanReply}
      memberDeptIds={permCtx.memberDeptIds}
    />
  );
}
