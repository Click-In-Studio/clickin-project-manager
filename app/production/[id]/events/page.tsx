import type { Metadata } from "next";
import { canAccessNode } from "@/lib/grant-template";
import { hasAnyEffectiveGrant, hasEffectiveGrant } from "@/lib/grant-check";
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
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: access.permCtx.isAdmin, isOwner: access.permCtx.isOwner }, id, "event", ["meta", "details"], "view"))) redirect(`/unauthorized?resource=event%3Afollow&id=${id}`);

  const canViewFull = await hasEffectiveGrant({ userId: session.userId, isAdmin: access.permCtx.isAdmin, isOwner: access.permCtx.isOwner }, id, "event", "*", "call_sheet", "view");
  const canCreate = (await canAccessNode(access.permCtx, id, "event", "*", "*", "create")).allowed;

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
