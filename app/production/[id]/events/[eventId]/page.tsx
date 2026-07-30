import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listProductionMembersWithRoles, listVersions } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
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

  const _prodAccess = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!_prodAccess) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${productionId}`);
  const { permCtx: prodPermCtx } = _prodAccess;
  if (!hasPermission("event:follow", prodPermCtx)) redirect(`/unauthorized?resource=${encodeURIComponent("日程跟踪")}&id=${productionId}`);

  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  const canViewFull = hasPermission("event:edit", prodPermCtx);

  // Non-editors always go to the follower view (which enforces status visibility too)
  if (!canViewFull) redirect(`/production/${productionId}/events/${eventId}/view`);

  const name = await getProductionName(productionId);
  if (!name) notFound();

  const eventPermCtx = await loadEventPermContext(session.userId, eventId);

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

  const canEdit = hasPermission("event:edit", prodPermCtx);
  const canScheduleEdit = hasPermission("event:edit_schedule", prodPermCtx);
  const canAssignPeople = hasPermission("event:assign_participants", prodPermCtx);
  const canCallEdit = hasPermission("event:edit_call", prodPermCtx);
  const canTechReqDelete = hasPermission("event:delete_tech_req_any", prodPermCtx);
  const userCanWriteReport = canWriteReport(prodPermCtx, eventPermCtx);
  const canEditAnyTechReq = canEditTechReq(prodPermCtx, eventPermCtx, null);
  const pocDeptIds = eventPermCtx.pocDeptIds;

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
