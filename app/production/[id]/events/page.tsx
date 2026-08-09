import type { Metadata } from "next";
export const metadata: Metadata = { title: "事件" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { listProductionEvents, listUserEventParticipations, listEventDepartments } from "@/lib/event-db";
import EventsClient from "@/components/EventsClient";
import PageActivationGate from "@/components/PageActivationGate";

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!hasPermission("event:view", access.permCtx)) redirect(`/unauthorized?resource=event%3Aview&id=${id}`);

  const canViewFull = hasPermission("event:view_call_sheet_any", access.permCtx);
  const canCreate = hasPermission("event:create", access.permCtx);

  const [name, allEvents, myParticipations, departments] = await Promise.all([
    getProductionName(id),
    listProductionEvents(id),
    listUserEventParticipations(session.userId, id),
    listEventDepartments(id),
  ]);
  if (!name) notFound();

  const VISIBLE_STATUSES = new Set(["published", "completed"]);
  const events = canViewFull
    ? allEvents
    : allEvents.filter(e => VISIBLE_STATUSES.has(e.status));

  return (
    <>
      <EventsClient
        productionId={id}
        productionName={name}
        initialEvents={events}
        canCreate={canCreate}
        canViewFull={canViewFull}
        myParticipations={myParticipations}
        currentUserId={session.userId}
        departments={canCreate ? departments : []}
      />
      <PageActivationGate productionId={id} scope="events" />
    </>
  );
}
