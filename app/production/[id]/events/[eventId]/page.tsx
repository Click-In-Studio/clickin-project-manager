import type { Metadata } from "next";
import { hasEffectiveGrant, hasGrant, toActor } from "@/lib/grant-check";
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

  listEventDepartments,
  getSelfParticipantRole,
} from "@/lib/event-db";
import { canEnterEvent, isReportViewer, loadEventPermContext } from "@/lib/event-permissions";
import { getEventAccess } from "@/lib/resource-grant-db";
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
  // 门 = 域 view 行，或通过用户组参与了这个 event（后者是 Type B 上下文判定，
  // 见 canEnterEvent）。批B 两职拆分：订阅=followers@create、读取=meta/details@view——
  // 申请节点=meta@view 才与门一致（非 verb swap）
  if (!(await canEnterEvent(toActor(session, prodPermCtx), productionId, eventId)))
    redirect(`/unauthorized?resource=node%3Aevent%2F*%2Fmeta%40view&id=${productionId}`);

  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  // Check per-event resource grant
  const accessResult = (prodPermCtx.isAdmin || prodPermCtx.isOwner)
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

  // W5：默认报告懒建已移除（浏览即建会在文档树留足迹）——空态由
  // EventDetailClient 的显式创建流承担（暂无记录 + 添加按钮）
  const reports = rawReports;

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
    (reports.length > 0 && await hasGrant(session.userId, productionId, "report", reports[0].id, "*", "edit"));
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
