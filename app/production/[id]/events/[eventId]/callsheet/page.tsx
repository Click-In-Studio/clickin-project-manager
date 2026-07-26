import type { Metadata } from "next";
export const metadata: Metadata = { title: "Call Sheet" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { loadEventPermContext } from "@/lib/event-permissions";
import {
  getProductionEvent,
  listScheduleItemsWithParticipants,
  listEventCallTimes,
  listEventDepartments,
} from "@/lib/event-db";
import CallSheetClient from "@/components/CallSheetClient";

export default async function CallSheetPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: productionId, eventId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const event = await getProductionEvent(eventId, productionId);
  if (!event) redirect("/");

  // Check access: event:edit (production member with full view) OR in the call
  const [_prodAccess, eventPermCtx] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    loadEventPermContext(session.userId, eventId),
  ]);
  if (!_prodAccess) redirect("/");
  const { permCtx: prodPermCtx } = _prodAccess;
  const canViewFull = hasPermission("event:edit", prodPermCtx);

  const VISIBLE_STATUSES = new Set(["published", "completed"]);
  if (!canViewFull && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/events`);

  if (!canViewFull && !eventPermCtx.isInCall) redirect(`/production/${productionId}/events/${eventId}/view`);

  const [scheduleItems, callTimes, departments] = await Promise.all([
    listScheduleItemsWithParticipants(eventId),
    listEventCallTimes(eventId),
    listEventDepartments(productionId),
  ]);

  return (
    <CallSheetClient
      productionId={productionId}
      eventId={eventId}
      event={event}
      scheduleItems={scheduleItems}
      callTimes={callTimes}
      departments={departments}
    />
  );
}
