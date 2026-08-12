import type { Metadata } from "next";
import { hasEffectiveGrant, hasGrant, toActor } from "@/lib/grant-check";
export const metadata: Metadata = { title: "技术需求" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionMembersWithRoles } from "@/lib/db";
import { getUserTechReqGrantIdsInEvent } from "@/lib/resource-grant-db";
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

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) redirect(`/unauthorized?id=${productionId}`);

  const event = await getProductionEvent(eventId, productionId);
  if (!event) notFound();

  // Admin role-level OR event resource_grant edit+ → full view
  // 批B：别人的技术需求是独立层（tasks@view / task 域通配），不与 call_sheet 合并
  const canViewFull = await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "task", "*", "*", "view")
    || await hasGrant(session.userId, productionId, "event", eventId, "tasks", "view")
    || await hasGrant(session.userId, productionId, "event", eventId, "details", "edit");

  const VISIBLE_STATUSES = new Set(["published", "completed"]);
  // draft 门 = publication@view 行（发布生命周期面的 view 档；保留段不被通配覆盖）
  const canSeeDraft = await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "event", eventId, "publication", "view");
  if (!canSeeDraft && !VISIBLE_STATUSES.has(event.status))
    redirect(`/production/${productionId}/events`);

  const [isAssignee, departments, productionMembers, grantedReqIds] = await Promise.all([
    isUserEventTechAssignee(eventId, session.userId),
    listEventDepartments(productionId),
    listProductionMembersWithRoles(productionId),
    canViewFull ? Promise.resolve([] as string[]) : getUserTechReqGrantIdsInEvent(session.userId, productionId, eventId),
  ]);

  // POC of any dept (old system) OR resource_grant holder (new system)
  const pocDeptIds = departments
    .filter(d => d.pocUserIds.includes(session.userId))
    .map(d => d.id);
  const grantedReqIdSet = new Set(grantedReqIds);

  if (!canViewFull && !isAssignee && pocDeptIds.length === 0 && grantedReqIds.length === 0)
    redirect(`/production/${productionId}/events/${eventId}/view`);

  const allReqs = await listEventTechReqs(eventId);

  // Non-full-viewers see: non-awaiting reqs, awaiting reqs for their POC depts,
  // and any req they have a direct resource_grant on
  const techReqs = canViewFull
    ? allReqs
    : allReqs.filter(req =>
        req.status !== "awaiting"
        || pocDeptIds.includes(req.departmentId ?? "")
        || grantedReqIdSet.has(req.id)
      );

  return (
    <ReqsClient
      productionId={productionId}
      eventId={eventId}
      event={event}
      techReqs={techReqs}
      departments={departments}
      currentUserId={session.userId}
      productionMembers={productionMembers.map(m => ({ userId: m.userId, name: m.name }))}
      canViewFull={canViewFull}
    />
  );
}
