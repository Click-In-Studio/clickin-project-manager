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

// #416 切页零往返：30 秒内切回本页直接命中 client router cache，不打服务端。
// 承 #258 的归因（切页耗时 90%+ 在网络往返，服务端仅 20–32ms）。
//
// 开这个开关的前提，是**本页自己能触发的写操作全部已失效缓存**——否则用户在本页写完
// 切走再切回来，组件会从写之前的 payload 重新播种，自己的写被打回。本页闭包内的写点
// 已全部走 lib/write-refresh，由 tests/stale-time-whitelist.test.tsx 持续把关：往闭包
// 里塞裸 fetch 写点，那条测试会红。
//
// 别处改的数据晚至多 30 秒是本开关明知接受的代价（见 #416）。
export const unstable_dynamicStaleTime = 30;



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
