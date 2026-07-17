import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getSession } from "@/lib/session";
import {
  canUserAccessProduction, getProductionName,
  getProductionMemberContext, listCueLists, listCueListPermissions,
  countWarningCues,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import ArchiveButton from "@/components/ArchiveButton";
import ProductionNameEditor from "@/components/ProductionNameEditor";
import ProductionMemberGuardLink from "@/components/ProductionMemberGuardLink";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const name = await getProductionName(id);
  return { title: name ?? "项目" };
}
import { canEditCueList } from "@/lib/cue-list-types";
import { listMyUpcomingCallTimes, listMyPendingTechReqs, listMyPocAwaitingReqs, listUnreadFollowedReports } from "@/lib/event-db";
import { fmtCallAt, fmtDate } from "@/lib/tz";

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: "待处理", in_progress: "进行中", done: "完成",
};

export default async function ProductionDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.userId, id);
    if (!ok) redirect("/");
  }

  const [name, cueLists, { memberRoles, overrides, isArchived }, callTimes, pendingReqs, awaitingReqs, unreadReports] = await Promise.all([
    getProductionName(id),
    listCueLists(id),
    getProductionMemberContext(session.userId, session.isAdmin, id),
    listMyUpcomingCallTimes(session.userId, id),
    listMyPendingTechReqs(session.userId, id),
    listMyPocAwaitingReqs(session.userId, id),
    listUnreadFollowedReports(session.userId, id),
  ]);
  const canManage = hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides);
  const isProjectMember = memberRoles !== null;
  if (!name) redirect("/");

  const editableListIds: string[] = [];
  await Promise.all(
    cueLists.map(async (cl) => {
      const perms = await listCueListPermissions(cl.id);
      if (canEditCueList(session.userId, memberRoles, session.isAdmin, cl, perms))
        editableListIds.push(cl.id);
    })
  );
  const warningCount = await countWarningCues(editableListIds);

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-10">
      <div className="w-full max-w-sm mx-auto">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              {isArchived && (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-widest uppercase bg-zinc-100 text-zinc-400">
                  已归档
                </span>
              )}
              <ProductionNameEditor productionId={id} name={name} canEdit={canManage} />
            </div>
            {canManage && <ArchiveButton productionId={id} isArchived={isArchived} />}
          </div>
        </div>

        {isArchived && (
          <div className="mb-6 rounded-xl bg-zinc-50 border border-zinc-200 px-4 py-3 text-xs text-zinc-400 text-center">
            该项目已归档，仅可查看，不可修改内容。
          </div>
        )}

        {/* Nav grid */}
        <div className="grid grid-cols-2 gap-3 mb-8">
          <Link href={`/production/${id}/contacts`}
            className="rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">People</p>
            <p className="text-base font-medium text-zinc-700">人员</p>
          </Link>
          <ProductionMemberGuardLink
            productionId={id}
            currentUserId={session.userId}
            href={`/production/${id}/dramaturgy`}
            title="戏剧构作"
            subtitle="Dramaturgy"
            accountName={session.name}
            isProjectMember={isProjectMember}
            isAdmin={session.isAdmin}
            className="rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow">
          </ProductionMemberGuardLink>
          <ProductionMemberGuardLink
            productionId={id}
            currentUserId={session.userId}
            href={`/production/${id}/script`}
            title="剧本"
            subtitle="Script"
            accountName={session.name}
            isProjectMember={isProjectMember}
            isAdmin={session.isAdmin}
            className="rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow">
          </ProductionMemberGuardLink>
          <ProductionMemberGuardLink
            productionId={id}
            currentUserId={session.userId}
            href={`/production/${id}/cues`}
            title="Cue视图"
            subtitle="Cue"
            accountName={session.name}
            isProjectMember={isProjectMember}
            isAdmin={session.isAdmin}
            className="relative rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow">
            {warningCount > 0 && (
              <span className="absolute top-2.5 right-2.5 flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                ⚠ {warningCount}
              </span>
            )}
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">Cue</p>
            <p className="text-base font-medium text-zinc-700">Cue视图</p>
          </ProductionMemberGuardLink>
          <Link href={`/production/${id}/events`}
            className="col-span-2 rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">Events</p>
            <p className="text-base font-medium text-zinc-700">排练 / 演出</p>
          </Link>
          <Link href={`/production/${id}/assets`}
            className="col-span-2 rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">Assets</p>
            <p className="text-base font-medium text-zinc-700">附件</p>
          </Link>
        </div>

        {/* Call times */}
        {callTimes.length > 0 && (
          <section className="mb-5">
            <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-2">
              本周我的 Call <span className="font-normal normal-case text-zinc-300">UTC+8</span>
            </h2>
            <div className="rounded-2xl bg-white shadow-sm overflow-hidden divide-y divide-zinc-50">
              {callTimes.map(ct => (
                <Link key={ct.id}
                  href={`/production/${id}/events/${ct.eventId}/callsheet`}
                  className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-800 truncate">{ct.eventTitle}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-zinc-400 flex-wrap">
                      {ct.eventLocation && <span>{ct.eventLocation}</span>}
                      {ct.notes && <><span>·</span><span className="truncate max-w-[140px]">{ct.notes}</span></>}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-sm font-medium text-amber-500">{fmtCallAt(ct.callAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Unread reports */}
        {unreadReports.length > 0 && (
          <section className="mb-5">
            <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-2">未读报告</h2>
            <div className="rounded-2xl bg-white shadow-sm overflow-hidden divide-y divide-zinc-50">
              {unreadReports.map(r => (
                <Link key={r.reportId}
                  href={`/production/${id}/events/${r.eventId}/reports/${r.reportId}`}
                  className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-800 truncate">{r.reportTitle}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-400 truncate">{r.eventTitle}</p>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-400">{fmtDate(r.publishedAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Awaiting tech reqs (POC needs to confirm) */}
        {awaitingReqs.length > 0 && (
          <section className="mb-5">
            <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-2">待确认需求</h2>
            <div className="rounded-2xl bg-white shadow-sm overflow-hidden divide-y divide-zinc-50">
              {awaitingReqs.map(req => (
                <Link key={req.id}
                  href={`/production/${id}/events/${req.eventId}/reqs/${req.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-800 truncate">
                      {req.departmentName ?? "（无部门）"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-400 truncate">{req.eventTitle}</p>
                  </div>
                  <span className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium bg-purple-50 text-purple-500">
                    待确认
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Pending tech reqs */}
        {pendingReqs.length > 0 && (
          <section className="mb-5">
            <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-2">我负责的待处理需求</h2>
            <div className="rounded-2xl bg-white shadow-sm overflow-hidden divide-y divide-zinc-50">
              {pendingReqs.map(req => (
                <Link key={req.id}
                  href={`/production/${id}/events/${req.eventId}/reqs/${req.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-800 truncate">{req.title}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-400 truncate">{req.eventTitle}</p>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium ${
                    req.status === "in_progress"
                      ? "bg-blue-50 text-blue-500"
                      : "bg-zinc-100 text-zinc-500"
                  }`}>
                    {REQ_STATUS_LABEL[req.status] ?? req.status}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
