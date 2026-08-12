import type { Metadata } from "next";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listProductionMembersWithRoles, listVersions } from "@/lib/db";
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
import { hasEventDomainView, isReportViewer, loadEventPermContext } from "@/lib/event-permissions";
import { getEventAccess, hasResourceGrantLevel } from "@/lib/resource-grant-db";
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
  if (!_prodAccess) redirect(`/unauthorized?id=${productionId}`);
  const { permCtx: prodPermCtx } = _prodAccess;
  if (!(await hasEventDomainView(toActor(session, prodPermCtx), productionId))) redirect(`/unauthorized?resource=event%3Afollow&id=${productionId}`);

  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  // Check per-event resource grant
  const accessResult = prodPermCtx.isAdmin
    ? { canAccess: true as const, level: "manage" as const }
    : await getEventAccess(session.userId, productionId, eventId);

  // No access and not in free-approval zone → redirect to follower view
  if (!accessResult.canAccess && !accessResult.canSelfConfirm) {
    redirect(`/production/${productionId}/events/${eventId}/view`);
  }

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

  // Derive capability booleans from the access result
  const hasEditGrant = accessResult.canAccess &&
    ["edit", "publish", "edit_published", "revoke", "manage"].includes(accessResult.level);

  const canEdit = hasEditGrant;
  const canScheduleEdit = hasEditGrant;
  const canAssignPeople = hasEditGrant;
  const canCallEdit = hasEditGrant;
  // admin bypass for deleting any tech req stays as atomic
  const canTechReqDelete = await hasEffectiveGrant(toActor(session, prodPermCtx), productionId, "task", "*", "*", "delete");
  // canWriteReport: check if user has edit+ on any report in this event OR has event edit grant
  const canWriteReport = hasEditGrant ||
    (reports.length > 0 && await hasResourceGrantLevel(session.userId, productionId, "report", reports[0].id, "edit"));
  const canEditAnyTechReq = hasEditGrant;
  const pocDeptIds = eventPermCtx.pocDeptIds;

  // Level 2-A: user is in free-approval zone but hasn't confirmed yet
  const needsSelfConfirm = !accessResult.canAccess && accessResult.canSelfConfirm;
  const selfConfirmLevel = needsSelfConfirm ? accessResult.selfConfirmLevel : undefined;

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
      canWriteReport={canWriteReport}
      canEditAnyTechReq={canEditAnyTechReq}
      pocDeptIds={pocDeptIds}
      currentUserId={session.userId}
      selfParticipantRole={selfRole}
      needsSelfConfirm={needsSelfConfirm}
      selfConfirmLevel={selfConfirmLevel}
    />
  );
}
