import type { Metadata } from "next";
export const metadata: Metadata = { title: "技术需求" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionMembersWithRoles } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getProductionEvent,
  listEventTechReqs,
  listEventDepartments,
  isUserEventTechAssignee,
} from "@/lib/event-db";
import ReqsClient from "@/components/ReqsClient";

export default async function ReqsPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: productionId, eventId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides)) redirect("/");

  const event = await getProductionEvent(eventId, productionId);
  if (!event) redirect(`/production/${productionId}/events`);

  const canViewFull = hasPermission("event:view_full", session.isAdmin, memberRoles, overrides);

  const VISIBLE_STATUSES = new Set(["published", "completed"]);
  if (!canViewFull && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/events`);

  const [isAssignee, departments, productionMembers] = await Promise.all([
    isUserEventTechAssignee(eventId, session.openId),
    listEventDepartments(productionId),
    listProductionMembersWithRoles(productionId),
  ]);

  // POC of any dept in this production can access to see their awaiting reqs
  const pocDeptIds = departments
    .filter(d => d.pocOpenIds.includes(session.openId))
    .map(d => d.id);

  if (!canViewFull && !isAssignee && pocDeptIds.length === 0)
    redirect(`/production/${productionId}/events/${eventId}/view`);

  const allReqs = await listEventTechReqs(eventId);

  // Non-full-viewers only see awaiting reqs for their own POC departments
  const techReqs = canViewFull
    ? allReqs
    : allReqs.filter(req =>
        req.status !== "awaiting" || pocDeptIds.includes(req.departmentId ?? "")
      );

  return (
    <ReqsClient
      productionId={productionId}
      eventId={eventId}
      event={event}
      techReqs={techReqs}
      departments={departments}
      currentUserOpenId={session.openId}
      productionMembers={productionMembers.map(m => ({ openId: m.openId, name: m.name }))}
    />
  );
}
