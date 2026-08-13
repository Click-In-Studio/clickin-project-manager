import type { Metadata } from "next";
import { hasEventDomainView, loadEventPermContext } from "@/lib/event-permissions";
import { hasEffectiveGrant, hasGrant, toActor } from "@/lib/grant-check";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import {
  getProductionEvent,
  listScheduleItemsWithParticipants,
  listEventReports,
  isUserEventTechAssignee,
  getSelfParticipantRole,
  listEventDepartments,
} from "@/lib/event-db";
import { hasUserAnyTechReqGrantInEvent } from "@/lib/resource-grant-db";
import { hasGrant as hasGrantCheck } from "@/lib/grant-check";
import EventFollowerClient from "@/components/EventFollowerClient";

export async function generateMetadata({ params }: { params: Promise<{ id: string; eventId: string }> }): Promise<Metadata> {
  const { id, eventId } = await params;
  const event = await getProductionEvent(eventId, id);
  return { title: event?.title ?? "事件" };
}

const VISIBLE_STATUSES = new Set(["published", "completed"]);

export default async function EventViewPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: productionId, eventId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const _prodAccess = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!_prodAccess) redirect(`/unauthorized?id=${productionId}`);
  const { permCtx: prodPermCtx } = _prodAccess;
  if (!(await hasEventDomainView(toActor(session, prodPermCtx), productionId))) redirect(`/unauthorized?resource=node%3Aevent%2F*%2Fmeta%40view&id=${productionId}`);

  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  // Per-instance production_member_grant edit+ → full editor view on this page
  const canViewFull = prodPermCtx.isAdmin
    || await hasGrant(session.userId, productionId, "event", eventId, "details", "edit");

  // Non-editors cannot see unpublished events
  // draft 门 = publication@view 行（发布生命周期面的 view 档；保留段不被通配覆盖）
  const canSeeDraft = await hasEffectiveGrant(toActor(session, prodPermCtx), productionId, "event", eventId, "publication", "view");
  if (!canSeeDraft && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/events`);

  const [scheduleItems, reports, isAssignee, selfRole, departments, hasAnyTechReqGrant] = await Promise.all([
    listScheduleItemsWithParticipants(eventId),
    listEventReports(eventId),
    isUserEventTechAssignee(eventId, session.userId),
    getSelfParticipantRole(eventId, session.userId),
    listEventDepartments(productionId),
    hasUserAnyTechReqGrantInEvent(session.userId, productionId, eventId),
  ]);

  const pocDeptIds = departments.filter(d => d.pocUserIds.includes(session.userId));
  const canViewReqsFull = await hasGrant(session.userId, productionId, "task", "*", "*", "view")
    || await hasGrant(session.userId, productionId, "event", eventId, "tasks", "view")
    || await hasGrant(session.userId, productionId, "event", eventId, "details", "edit")
    || prodPermCtx.isAdmin;
  const canViewReqs = canViewReqsFull || isAssignee || pocDeptIds.length > 0 || hasAnyTechReqGrant;

  const viewerPermCtx = await loadEventPermContext(session.userId, eventId);
  const visibleReports = canViewFull
    ? reports
    : (await Promise.all(
        reports.map(async r => {
          if (r.publishedAt !== null) return r;
          // 部门参与者可见 draft（发布前写 note 的业务规则）
          if (viewerPermCtx.participantDeptIds.length > 0) return r;
          const hasReportView = await hasGrantCheck(session.userId, productionId, "report", r.id, "publication", "view");
          return hasReportView ? r : null;
        })
      )).filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <EventFollowerClient
      productionId={productionId}
      eventId={eventId}
      event={event}
      scheduleItems={scheduleItems}
      departments={departments}
      reports={visibleReports}
      isAssignee={isAssignee}
      selfParticipantRole={selfRole}
      canViewFull={canViewFull}
      canViewReqs={canViewReqs}
    />
  );
}
