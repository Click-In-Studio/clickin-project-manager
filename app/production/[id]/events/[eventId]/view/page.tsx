import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
import { isReportViewer } from "@/lib/event-permissions";
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
  if (!_prodAccess) redirect("/");
  const { permCtx: prodPermCtx } = _prodAccess;
  if (!hasPermission("event:follow", prodPermCtx)) redirect("/");

  const event = await getProductionEvent(eventId, productionId);
  if (!event) redirect(`/production/${productionId}/events`);

  const canViewFull = hasPermission("event:edit", prodPermCtx);

  // Non-editors cannot see unpublished events
  if (!canViewFull && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/events`);

  const [scheduleItems, reports, isAssignee, selfRole, departments] = await Promise.all([
    listScheduleItemsWithParticipants(eventId),
    listEventReports(eventId),
    isUserEventTechAssignee(eventId, session.userId),
    getSelfParticipantRole(eventId, session.userId),
    listEventDepartments(productionId),
  ]);

  const pocDeptIds = departments.filter(d => d.pocUserIds.includes(session.userId));
  const canViewReqs = canViewFull || isAssignee || pocDeptIds.length > 0;

  const canViewReport = isReportViewer(prodPermCtx);
  const visibleReports = canViewReport ? reports : reports.filter(r => r.publishedAt !== null);

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
