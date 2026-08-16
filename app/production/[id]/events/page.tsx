import type { Metadata } from "next";
import { hasEventDomainView, filterDraftVisibleEvents } from "@/lib/event-permissions";
import { canAccessNode } from "@/lib/grant-template";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
export const metadata: Metadata = { title: "事件" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listProductionEvents, listUserEventParticipations, listEventDepartments, listEventTaskCounts } from "@/lib/event-db";
import EventsClient from "@/components/EventsClient";
import PageActivationGate from "@/components/PageActivationGate";

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!(await hasEventDomainView(toActor(session, access.permCtx), id))) // event:follow 批B 两职拆分：订阅=followers@create、读取=meta/details@view——
  // 此门是 hasEventDomainView（域 view），申请节点=meta@view 才与门一致（非 verb swap）
  redirect(`/unauthorized?resource=node%3Aevent%2F*%2Fmeta%40view&id=${id}`);

  const canViewFull = await hasEffectiveGrant(toActor(session, access.permCtx), id, "event", "*", "call_sheet", "view");
  const canCreate = (await canAccessNode(access.permCtx, id, "event", "*", "*", "create")).allowed;

  const [name, allEvents, myParticipations, departments, taskCounts] = await Promise.all([
    getProductionName(id),
    listProductionEvents(id),
    listUserEventParticipations(session.userId, id),
    listEventDepartments(id),
    listEventTaskCounts(id),
  ]);
  if (!name) notFound();

  const events = await filterDraftVisibleEvents(access.permCtx, id, allEvents);

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
        taskCounts={taskCounts}
      />
      <PageActivationGate productionId={id} scope="events" />
    </>
  );
}
