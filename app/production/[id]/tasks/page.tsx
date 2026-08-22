import type { Metadata } from "next";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
export const metadata: Metadata = { title: "任务" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { listProductionTechReqs, listMyTechReqsFull } from "@/lib/event-db";
import ProductionTasksClient from "@/components/ProductionTasksClient";
import PageHeader from "@/components/PageHeader";


export default async function ProductionTasksPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { id: productionId } = await params;
  const { event: eventFilter } = await searchParams;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    getProductionName(productionId),
  ]);
  if (!access) redirect(`/unauthorized?id=${productionId}`);
  if (!productionName) notFound();

  const canViewAll = await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "task", "*", "*", "view");

  const tasks = canViewAll
    ? await listProductionTechReqs(productionId)
    : (await listMyTechReqsFull(session.userId))
        .filter(t => t.productionId === productionId)
        .map(t => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          departmentId: t.departmentId,
          departmentName: t.departmentName,
          groupId: t.groupId,
          groupName: t.groupName,
          eventId: t.eventId,
          eventTitle: t.eventTitle,
          eventStartTime: null as string | null,
          startTime: null as string | null,
          endTime: null as string | null,
          effectiveStartTime: t.effectiveStartTime,
          effectiveEndTime: t.effectiveEndTime,
          phases: [] as { id: string; name: string; startDate: string; endDate: string | null }[],
          isBlocked: false,
          assignees: t.assignees,
        }));

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="Tasks" title="任务" side="stage" />
      <ProductionTasksClient productionId={productionId} initialTasks={tasks} initialEventFilter={eventFilter} currentUserId={session.userId} />
    </div>
  );
}
