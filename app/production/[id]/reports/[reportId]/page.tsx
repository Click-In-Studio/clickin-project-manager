import type { Metadata } from "next";
import { hasGrant, hasAnyGrant, toActor } from "@/lib/grant-check";
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
  if (!(await hasEventDomainView(toActor(session, prodPermCtx), productionId))) // event:follow 批B 两职拆分：订阅=followers@create、读取=meta/details@view——
  // 此门是 hasEventDomainView（域 view），申请节点=meta@view 才与门一致（非 verb swap）
  redirect(`/unauthorized?resource=node%3Aevent%2F*%2Fmeta%40view&id=${productionId}`);

  const report = await getReportByProduction(reportId, productionId);
  if (!report) notFound();

  const eventId = report.eventId;
  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  const eventPermCtx = await loadEventPermContext(session.userId, eventId);

  // 业务规则（用户定）：参加 event 的部门要在发布前给 report 写 note
  // → 部门参与者可见 draft report（上下文判定，与 canWriteNote 的授权面对齐）
  const canViewReportUnpublished = await isReportViewer(prodPermCtx, productionId)
    || eventPermCtx.participantDeptIds.length > 0
    || await hasGrant(session.userId, productionId, "event", eventId, "reports", "view")
    || await hasGrant(session.userId, productionId, "report", reportId, "publication", "view");

  if (!canViewReportUnpublished && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/reports`);

  if (!report.publishedAt && !canViewReportUnpublished)
    redirect(`/production/${productionId}/reports`);

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
    // 批C C3：dept/<D>/notes@create 行（POC/导演通配）——本人无需在 event 中
    || await hasAnyGrant(session.userId, productionId, "dept", ["notes"], "create")
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
