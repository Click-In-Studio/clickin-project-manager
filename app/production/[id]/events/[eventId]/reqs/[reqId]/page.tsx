import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionMembersWithRoles } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getProductionEvent,
  getEventTechReq,
  listScheduleItems,
  listEventDepartments,
} from "@/lib/event-db";
import ReqDetailClient from "@/components/ReqDetailClient";

export async function generateMetadata({ params }: { params: Promise<{ eventId: string; reqId: string }> }): Promise<Metadata> {
  const { eventId, reqId } = await params;
  const req = await getEventTechReq(reqId, eventId);
  return { title: req?.title ?? "技术需求" };
}

type Ctx = { params: Promise<{ id: string; eventId: string; reqId: string }> };

export default async function ReqDetailPage({ params }: Ctx) {
  const { id: productionId, eventId, reqId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(
    session.openId, session.isAdmin, productionId
  );
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    redirect("/");

  const [event, req, scheduleItems, departments, productionMembers] = await Promise.all([
    getProductionEvent(eventId, productionId),
    getEventTechReq(reqId, eventId),
    listScheduleItems(eventId),
    listEventDepartments(productionId),
    listProductionMembersWithRoles(productionId),
  ]);

  if (!event) redirect(`/production/${productionId}/events`);
  if (!req) redirect(`/production/${productionId}/events/${eventId}/reqs`);

  const canViewFull = hasPermission("event:view_full", session.isAdmin, memberRoles, overrides);
  const pocDeptIds = departments
    .filter(d => d.pocOpenIds.includes(session.openId))
    .map(d => d.id);
  const isPocOfDept = req.departmentId ? pocDeptIds.includes(req.departmentId) : false;
  const isAssignee = req.assignees.some(a => a.openId === session.openId);

  if (!canViewFull && !isPocOfDept && !isAssignee)
    redirect(`/production/${productionId}/events/${eventId}/reqs`);

  const dept = departments.find(d => d.id === req.departmentId);
  const deptPeople = dept
    ? productionMembers
        .filter(m => new Set([...dept.memberOpenIds, ...dept.pocOpenIds]).has(m.openId))
        .map(m => ({ openId: m.openId, name: m.name }))
    : [];

  const allPeople = productionMembers.map(m => ({ openId: m.openId, name: m.name }));

  return (
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
  );
}
