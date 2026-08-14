import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { toActor, listGrantedResourceIds } from "@/lib/grant-check";
import { hasEventDomainView } from "@/lib/event-permissions";
import { getProductionPermissionContext, getProductionName, listMilestones } from "@/lib/db";
import { listProductionEvents, listEventDepartments } from "@/lib/event-db";
import PlanningClient from "@/components/PlanningClient";

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

  const [name, allEvents, milestones, departments] = await Promise.all([
    getProductionName(id),
    listProductionEvents(id),
    listMilestones(id),
    listEventDepartments(id),
  ]);
  if (!name) notFound();

  // draft 可见性与事件页同门（publication@view 行）
  const VISIBLE_STATUSES = new Set(["published", "completed"]);
  const draftVis = (access.permCtx.isAdmin || access.permCtx.isOwner)
    ? { wildcard: true, ids: [] as string[] }
    : await listGrantedResourceIds(session.userId, id, "event", "publication", "view");
  const events = draftVis.wildcard
    ? allEvents
    : allEvents.filter(e => VISIBLE_STATUSES.has(e.status) || draftVis.ids.includes(e.id));

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={`Planning · ${name}`} title="计划与日程" side="stage" />
      <PlanningClient
        productionId={id}
        events={events}
        milestones={milestones.map(m => ({ id: m.id, name: m.name, endDate: m.endDate }))}
        departments={departments.map(d => ({ id: d.id, name: d.name }))}
      />
    </div>
  );
}
