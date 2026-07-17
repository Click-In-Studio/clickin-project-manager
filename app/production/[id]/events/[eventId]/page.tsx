import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listProductionMembersWithRoles, listVersions } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getProductionEvent,
  listScheduleItemsWithParticipants,
  listEventPeople,
  listEventCallTimes,
  listEventTechReqs,
  listEventReports,
  createEventReport,
  listEventDepartments,
  getSelfParticipantRole,
} from "@/lib/event-db";
import { loadEventPermContext, canWriteReport, canEditTechReq } from "@/lib/event-permissions";
import EventDetailClient from "@/components/EventDetailClient";

export async function generateMetadata({ params }: { params: Promise<{ id: string; eventId: string }> }): Promise<Metadata> {
  const { id, eventId } = await params;
  const event = await getProductionEvent(eventId, id);
  return { title: event?.title ?? "事件" };
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: productionId, eventId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides)) redirect("/");

  const event = await getProductionEvent(eventId, productionId);
  if (!event) redirect(`/production/${productionId}/events`);

  const canViewFull = hasPermission("event:view_full", session.isAdmin, memberRoles, overrides);

  // Non-editors always go to the follower view (which enforces status visibility too)
  if (!canViewFull) redirect(`/production/${productionId}/events/${eventId}/view`);

  const name = await getProductionName(productionId);
  if (!name) redirect("/");

  const permCtx = await loadEventPermContext(session.userId, eventId);

  const [scheduleItems, eventPeople, callTimes, techReqs, rawReports, departments, members, selfRole, versions] =
    await Promise.all([
      listScheduleItemsWithParticipants(eventId),
      listEventPeople(eventId),
      listEventCallTimes(eventId),
      listEventTechReqs(eventId),
      listEventReports(eventId),
      listEventDepartments(productionId),
      listProductionMembersWithRoles(productionId),
      getSelfParticipantRole(eventId, session.userId),
      listVersions(productionId),
    ]);

  let reports = rawReports;
  if (reports.length === 0) {
    // eslint-disable-next-line react-hooks/purity -- Server Component, not subject to render purity rules
    const seq = `rpt${Date.now().toString(36)}`;
    const defaultReport = await createEventReport({
      id: seq, eventId, reportType: "rehearsal",
      title: "排练记录", body: "", createdBy: session.userId,
    });
    reports = [defaultReport];
  }

  const canEdit = hasPermission("event:edit", session.isAdmin, memberRoles, overrides);
  const canScheduleEdit = hasPermission("event:schedule_edit", session.isAdmin, memberRoles, overrides);
  const canAssignPeople = hasPermission("event:assign_people", session.isAdmin, memberRoles, overrides);
  const canCallEdit = hasPermission("event:call_edit", session.isAdmin, memberRoles, overrides);
  const canTechReqDelete = hasPermission("event:tech_req_delete", session.isAdmin, memberRoles, overrides);
  const userCanWriteReport = canWriteReport(session.isAdmin, memberRoles, overrides, permCtx);
  const canEditAnyTechReq = canEditTechReq(session.isAdmin, memberRoles, overrides, permCtx, null);
  const pocDeptIds = permCtx.pocDeptIds;

  return (
    <EventDetailClient
      productionId={productionId}
      productionName={name}
      event={event}
      initialScheduleItems={scheduleItems}
      initialEventPeople={eventPeople}
      initialCallTimes={callTimes}
      initialTechReqs={techReqs}
      initialReports={reports}
      departments={departments}
      members={members}
      versions={versions}
      canEdit={canEdit}
      canScheduleEdit={canScheduleEdit}
      canAssignPeople={canAssignPeople}
      canCallEdit={canCallEdit}
      canTechReqDelete={canTechReqDelete}
      canWriteReport={userCanWriteReport}
      canEditAnyTechReq={canEditAnyTechReq}
      pocDeptIds={pocDeptIds}
      currentUserId={session.userId}
      selfParticipantRole={selfRole}
    />
  );
}
