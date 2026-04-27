import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { listProductionEvents, listUserEventParticipations, listEventDepartments } from "@/lib/event-db";
import EventsClient from "@/components/EventsClient";

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canViewFull = hasPermission("event:view_full", session.isAdmin, memberRoles, overrides);
  const canCreate = hasPermission("event:create", session.isAdmin, memberRoles, overrides);

  const [name, allEvents, myParticipations, departments] = await Promise.all([
    getProductionName(id),
    listProductionEvents(id),
    listUserEventParticipations(session.openId, id),
    listEventDepartments(id),
  ]);
  if (!name) redirect("/");

  const VISIBLE_STATUSES = new Set(["published", "completed"]);
  const events = canViewFull
    ? allEvents
    : allEvents.filter(e => VISIBLE_STATUSES.has(e.status));

  return (
    <EventsClient
      productionId={id}
      productionName={name}
      initialEvents={events}
      canCreate={canCreate}
      canViewFull={canViewFull}
      myParticipations={myParticipations}
      currentUserOpenId={session.openId}
      departments={canCreate ? departments : []}
    />
  );
}
