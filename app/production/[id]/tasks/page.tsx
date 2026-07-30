import type { Metadata } from "next";
export const metadata: Metadata = { title: "任务" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { listProductionTechReqs, listMyTechReqsFull } from "@/lib/event-db";
import ProductionTasksClient from "@/components/ProductionTasksClient";


export default async function ProductionTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    getProductionName(productionId),
  ]);
  if (!access) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${productionId}`);
  if (!productionName) notFound();

  const canViewAll = hasPermission("event:view_tech_req_any", access.permCtx);

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
          eventId: t.eventId,
          eventTitle: t.eventTitle,
          eventStartTime: null as string | null,
          assignees: t.assignees,
        }));

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <div>
        <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>Tasks</p>
        <h1 style={{ margin: "0 0 20px", fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em" }}>任务</h1>
      </div>
      <ProductionTasksClient productionId={productionId} initialTasks={tasks} />
    </div>
  );
}
