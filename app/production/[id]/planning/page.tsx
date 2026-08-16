import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { toActor, hasEffectiveGrant } from "@/lib/grant-check";
import { hasEventDomainView, filterDraftVisibleEvents } from "@/lib/event-permissions";
import { getProductionPermissionContext, getProductionName, listMilestones } from "@/lib/db";
import { listProductionEvents, listEventDepartments, listProductionTechReqs, listMyTechReqsFull } from "@/lib/event-db";
import PlanningClient, { type PlanningTask } from "@/components/PlanningClient";

export const metadata: Metadata = { title: "计划与日程" };

export default async function PlanningPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!(await hasEventDomainView(toActor(session, access.permCtx), id)))
    redirect(`/unauthorized?resource=node%3Aevent%2F*%2Fmeta%40view&id=${id}`);

  const [name, allEvents, milestones, departments, canViewAllTasks] = await Promise.all([
    getProductionName(id),
    listProductionEvents(id),
    listMilestones(id),
    listEventDepartments(id),
    hasEffectiveGrant(toActor(session, access.permCtx), id, "task", "*", "*", "view"),
  ]);
  if (!name) notFound();

  // draft 可见性与事件页同门（共享 helper，防规则分叉）
  const events = await filterDraftVisibleEvents(access.permCtx, id, allEvents);

  // 任务视图与任务页同门：全量视图需 task/*@view，否则退化为与我相关的任务
  const tasks: PlanningTask[] = canViewAllTasks
    ? (await listProductionTechReqs(id)).map(t => ({
        id: t.id, title: t.title, status: t.status,
        departmentId: t.departmentId, departmentName: t.departmentName,
        eventId: t.eventId, eventTitle: t.eventTitle,
        startTime: t.startTime, endTime: t.endTime,
        effectiveStartTime: t.effectiveStartTime, effectiveEndTime: t.effectiveEndTime,
        isBlocked: t.isBlocked,
      }))
    : (await listMyTechReqsFull(session.userId))
        .filter(t => t.productionId === id)
        .map(t => ({
          id: t.id, title: t.title, status: t.status,
          departmentId: t.departmentId, departmentName: t.departmentName,
          eventId: t.eventId, eventTitle: t.eventTitle,
          startTime: null, endTime: null,
          effectiveStartTime: t.effectiveStartTime, effectiveEndTime: t.effectiveEndTime,
          isBlocked: false,
        }));

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={`Planning · ${name}`} title="计划与日程" side="stage" />
      <PlanningClient
        productionId={id}
        events={events}
        tasks={tasks}
        milestones={milestones.map(m => ({ id: m.id, name: m.name, endDate: m.endDate }))}
        departments={departments.map(d => ({ id: d.id, name: d.name }))}
      />
    </div>
  );
}
