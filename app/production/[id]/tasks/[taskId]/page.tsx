import type { Metadata } from "next";
import { hasEffectiveGrant } from "@/lib/grant-check";
import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionMembersWithRoles } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import {
  getTechReqByProduction,
  getProductionEvent,
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

  const [event, scheduleItems, departments, productionMembers] = await Promise.all([
    getProductionEvent(eventId, productionId),
    listScheduleItems(eventId),
    listEventDepartments(productionId),
    listProductionMembersWithRoles(productionId),
  ]);

  if (!event) notFound();

  const canViewFull = await hasEffectiveGrant({ userId: session.userId, isAdmin: access.permCtx.isAdmin, isOwner: access.permCtx.isOwner }, productionId, "event", "*", "call_sheet", "view");
  const pocDeptIds = departments
    .filter(d => d.pocUserIds.includes(session.userId))
    .map(d => d.id);
  const isPocOfDept = req.departmentId ? pocDeptIds.includes(req.departmentId) : false;
  const isAssignee = req.assignees.some(a => a.userId === session.userId);

  if (!canViewFull && !isPocOfDept && !isAssignee)
    redirect(`/unauthorized?resource=task%3Aview&id=${productionId}&taskId=${taskId}`);

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
        isPocOfDept={isPocOfDept}
        isAssignee={isAssignee}
        canViewFull={canViewFull}
        productionId={productionId}
      />
    </Suspense>
  );
}
