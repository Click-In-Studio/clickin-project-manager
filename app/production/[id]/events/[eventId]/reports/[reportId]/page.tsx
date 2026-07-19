import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { getProductionMemberContext, listProductionMembers } from "@/lib/db";
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
  return { title: report?.title ?? "报告" };
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

    const [notes, departments, replies, allMembers] = await Promise.all([
      listReportNotes(reportId),
      listEventDepartments(productionId),
      listReportReplies(reportId),
      listProductionMembers(productionId),
    ]);

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

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
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

  const permCtx = await loadEventPermContext(session.userId, eventId);

  const [notes, departments, replies, allMembers] = await Promise.all([
    listReportNotes(reportId),
    listEventDepartments(productionId),
    listReportReplies(reportId),
    listProductionMembers(productionId),
  ]);

  if (report.publishedAt) {
    await markReportRead(reportId, session.userId);
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
      currentUserId={session.userId}
      isPublished={!!report.publishedAt}
      replies={replies}
      canReply={userCanReply}
      memberDeptIds={permCtx.memberDeptIds}
      members={allMembers.map(m => ({ openId: m.openId, userId: m.userId, name: m.name }))}
    />
  );
}
