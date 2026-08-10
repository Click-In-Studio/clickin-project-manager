import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import {
  getProductionEvent,
  listScheduleItemsWithParticipants,
  listEventReports,
  isUserEventTechAssignee,
  getSelfParticipantRole,
  listEventDepartments,
} from "@/lib/event-db";
import { hasResourceGrantLevel, hasUserAnyTechReqGrantInEvent } from "@/lib/resource-grant-db";
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
  if (!hasPermission("event:follow", prodPermCtx)) redirect(`/unauthorized?resource=event%3Afollow&id=${productionId}`);

  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  // Per-instance resource_grant edit+ → full editor view on this page
  const canViewFull = prodPermCtx.isAdmin
    || await hasResourceGrantLevel(session.userId, productionId, "event", eventId, "edit");

  // Non-editors cannot see unpublished events
  if (!canViewFull && !VISIBLE_STATUSES.has(event.status))
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
  const canViewReqs = canViewFull || isAssignee || pocDeptIds.length > 0 || hasAnyTechReqGrant;

  const visibleReports = canViewFull
    ? reports
    : (await Promise.all(
        reports.map(async r => {
          if (r.publishedAt !== null) return r;
          const hasGrant = await hasResourceGrantLevel(session.userId, productionId, "report", r.id, "view");
          return hasGrant ? r : null;
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
