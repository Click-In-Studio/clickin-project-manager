import type { Metadata } from "next";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionMembersWithRoles, listMilestones } from "@/lib/db";
import {
  getTechReqByProduction,
  getProductionEvent,
  getTaskDependencies,
  listScheduleItems,
  listEventDepartments,
} from "@/lib/event-db";
import ReqDetailClient from "@/components/ReqDetailClient";

export async function generateMetadata({ params }: { params: Promise<{ id: string; taskId: string }> }): Promise<Metadata> {
  const { id: productionId, taskId } = await params;
  const req = await getTechReqByProduction(taskId, productionId);
  return { title: req?.title ?? "技术需求" };
}

type Ctx = { params: Promise<{ id: string; taskId: string }> };

export default async function TaskDetailPage({ params }: Ctx) {
  const { id: productionId, taskId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) redirect(`/unauthorized?id=${productionId}`);

  const req = await getTechReqByProduction(taskId, productionId);
  if (!req) notFound();

  const eventId = req.eventId;

  const [event, scheduleItems, departments, productionMembers, allMilestones, dependencies] = await Promise.all([
    eventId ? getProductionEvent(eventId, productionId) : Promise.resolve(null),
    eventId ? listScheduleItems(eventId) : Promise.resolve([]),
    listEventDepartments(productionId),
    listProductionMembersWithRoles(productionId),
    listMilestones(productionId),
    getTaskDependencies(taskId),
  ]);

  if (eventId && !event) notFound();

  const boundMilestones = allMilestones
    .filter(m => req.milestoneIds.includes(m.id))
    .map(m => ({ id: m.id, name: m.name, endDate: m.endDate }));

  const canViewFull = await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "task", "*", "*", "view");
  const pocDeptIds = departments
    .filter(d => d.pocUserIds.includes(session.userId))
    .map(d => d.id);
  const isPocOfDept = req.departmentId ? pocDeptIds.includes(req.departmentId) : false;
  const isAssignee = req.assignees.some(a => a.userId === session.userId);

  if (!canViewFull && !isPocOfDept && !isAssignee)
    redirect(`/unauthorized?resource=node%3Atask%2F*%2Fmeta%40view&id=${productionId}&taskId=${taskId}`);

  const dept = departments.find(d => d.id === req.departmentId);
  const deptPeople = dept
    ? productionMembers
        .filter(m => new Set([...dept.memberUserIds, ...dept.pocUserIds]).has(m.userId))
        .map(m => ({ userId: m.userId, name: m.name }))
    : [];

  const allPeople = productionMembers.map(m => ({ userId: m.userId, name: m.name }));

  return (
    <Suspense>
      <ReqDetailClient
        req={req}
        event={event}
        scheduleItems={scheduleItems}
        deptName={dept?.name ?? null}
        deptPeople={deptPeople}
        allPeople={allPeople}
        milestones={boundMilestones}
        blockedBy={dependencies.blockedBy}
        blocks={dependencies.blocks}
        isPocOfDept={isPocOfDept}
        isAssignee={isAssignee}
        canViewFull={canViewFull}
        productionId={productionId}
      />
    </Suspense>
  );
}
