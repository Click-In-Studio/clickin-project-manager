"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { MyCallTimeEntry, MyPendingTechReqEntry, MyPocAwaitingReqEntry, UnreadReportEntry } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import { fmtCallAt } from "@/lib/tz";
import styles from "@/components/home.module.css";

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: "待处理", in_progress: "进行中",
};

type Announcement = {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
};

type Milestone = {
  id: string;
  name: string;
  endDate: string;
};

type MyWorkData = {
  callTimes: MyCallTimeEntry[];
  pendingReqs: MyPendingTechReqEntry[];
  awaitingReqs: MyPocAwaitingReqEntry[];
  unreadReports: UnreadReportEntry[];
  isArchived: boolean;
  pinnedAnnouncement: Announcement | null;
  nextMilestone: Milestone | null;
  cueWarningCount: number;
};

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function plainSnippet(md: string, maxLen = 120): string {
  return md
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ── 项目进展 hero ─────────────────────────────────────────────────────────────

function ProjectProgressHero({
  data,
  productionId,
}: {
  data: MyWorkData;
  productionId: string;
}) {
  const { pinnedAnnouncement, nextMilestone, cueWarningCount, awaitingReqs } = data;

  useEffect(() => {
    if (!pinnedAnnouncement) return;
    fetch(`${BASE_PATH}/api/production/${productionId}/announcements/${pinnedAnnouncement.id}/read`, {
      method: "POST",
    }).catch(() => {});
  }, [pinnedAnnouncement?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = nextMilestone ? daysUntil(nextMilestone.endDate) : null;

  const milestoneLabel = (() => {
    if (days === null) return "暂无里程碑";
    if (days < 0) return `已过 ${Math.abs(days)} 天`;
    if (days === 0) return "今天";
    return `${days} 天`;
  })();

  const milestoneSubLabel = nextMilestone
    ? `距「${nextMilestone.name}」`
    : "尚未设置里程碑";

  const snippet = pinnedAnnouncement?.content ? plainSnippet(pinnedAnnouncement.content) : "";
  const hasMore = (pinnedAnnouncement?.content ?? "").replace(/\s/g, "").length > 120;

  return (
    <section className={styles.progressHero}>
      {/* 左：置顶公告 */}
      <div className={styles.progressHeroIntro}>
        <p className={styles.progressEyebrow}>PROJECT PROGRESS · 项目进展</p>
        {pinnedAnnouncement ? (
          <>
            <h2 className={styles.progressHeroTitle}>{pinnedAnnouncement.title}</h2>
            {snippet && (
              <p className={styles.progressHeroText}>
                {snippet}{hasMore ? "…" : ""}
              </p>
            )}
          </>
        ) : (
          <h2 className={styles.progressHeroTitle} style={{ opacity: 0.45 }}>
            暂无置顶公告
          </h2>
        )}
        <Link
          href={`/production/${productionId}/notifications`}
          className={styles.progressHeroLink}
        >
          查看我的通知 →
        </Link>
      </div>

      {/* 右：三格指标 */}
      <div className={styles.progressHeroMetrics}>
        {/* 里程碑倒计时 */}
        <div className={`${styles.progressMetricCard} ${days !== null && days <= 7 ? styles.progressMetricUrgent : ""}`}>
          <strong>{milestoneLabel}</strong>
          <span>{milestoneSubLabel}</span>
          {days !== null && days <= 7 && days >= 0 && <small>临近节点</small>}
        </div>

        {/* 待处理通知 */}
        <Link
          href={`/production/${productionId}/notifications`}
          className={`${styles.progressMetricCard} ${styles.progressMetricLink} ${awaitingReqs.length > 0 ? styles.progressMetricActive : ""}`}
        >
          <strong>{awaitingReqs.length}</strong>
          <span>待处理通知</span>
          {awaitingReqs.length > 0 && <small>需要你的确认</small>}
        </Link>

        {/* Cue 风险 */}
        <Link
          href={`/production/${productionId}/cues`}
          className={`${styles.progressMetricCard} ${styles.progressMetricLink} ${cueWarningCount > 0 ? styles.progressMetricWarn : ""}`}
        >
          <strong>{cueWarningCount}</strong>
          <span>Cue 风险提示</span>
          {cueWarningCount > 0 && <small>有待处理风险</small>}
        </Link>
      </div>
    </section>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function ProductionHomeClient({
  productionId,
  productionName,
}: {
  productionId: string;
  productionName: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<MyWorkData | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/my-work`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, [productionId]);

  const callTimes = data?.callTimes ?? [];
  const pendingReqs = data?.pendingReqs ?? [];
  const awaitingReqs = data?.awaitingReqs ?? [];
  const unreadReports = data?.unreadReports ?? [];
  const isArchived = data?.isArchived ?? false;
  const loading = data === null;

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>{productionName}</p>
        <h1 className={styles.pageTitle}>我的工作</h1>
      </div>

      {isArchived && (
        <div style={{
          marginBottom: 18, borderRadius: 10,
          background: "var(--surface-2)", border: "1px solid var(--line)",
          padding: "12px 18px", fontSize: 12, color: "var(--muted)", textAlign: "center",
        }}>
          该项目已归档，仅可查看
        </div>
      )}

      {/* 项目进展 hero */}
      {loading ? (
        <div className={styles.progressHero} style={{ minHeight: 180, alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>加载中…</div>
        </div>
      ) : (
        <ProjectProgressHero data={data!} productionId={productionId} />
      )}

      {/* Dashboard panels */}
      <div className={styles.dashboardGrid}>
        <div className={styles.dashboardCol}>

          {/* 日程 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>My Schedule</p>
                <h2>本周日程</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {loading ? (
                <div className={styles.emptyState}>加载中…</div>
              ) : callTimes.length === 0 ? (
                <div className={styles.emptyState}>本周暂无 Call</div>
              ) : (
                <div className={styles.timelineList}>
                  {callTimes.slice(0, 3).map(ct => (
                    <button
                      key={ct.id}
                      onClick={() => router.push(`/production/${productionId}/events/${ct.eventId}/callsheet`)}
                    >
                      <time>{fmtCallAt(ct.callAt)}</time>
                      <span className={styles.timelineLabel}>
                        <b>{ct.eventTitle}</b>
                        <small>
                          {ct.eventLocation ? ct.eventLocation : ""}
                          {ct.notes ? (ct.eventLocation ? ` · ${ct.notes}` : ct.notes) : ""}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href={`/production/${productionId}/events`} className={styles.panelSeeAll}>
                {callTimes.length > 3 ? `查看全部 ${callTimes.length} 条 →` : "查看所有 Event →"}
              </Link>
            </div>
          </section>

          {/* 待确认 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>Action Required</p>
                <h2>待确认</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {loading ? (
                <div className={styles.emptyState}>加载中…</div>
              ) : awaitingReqs.length === 0 ? (
                <div className={styles.emptyState}>暂无待确认事项</div>
              ) : (
                <div className={styles.compactList}>
                  {awaitingReqs.slice(0, 3).map(req => (
                    <button
                      key={req.id}
                      onClick={() => router.push(`/production/${productionId}/tasks/${req.id}`)}
                    >
                      <span className={styles.compactLabel}>
                        <b>{req.departmentName ?? "（无部门）"}</b>
                        <small>{req.eventTitle}</small>
                      </span>
                      <span className={styles.badge} style={{ background: "#f3eeff", color: "#7c3aed" }}>
                        待确认
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href={`/production/${productionId}/notifications`} className={styles.panelSeeAll}>
                {awaitingReqs.length > 3 ? `查看全部 ${awaitingReqs.length} 条 →` : "查看通知 →"}
              </Link>
            </div>
          </section>

        </div>
        <div className={styles.dashboardCol}>

          {/* 我的任务 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>My Tasks</p>
                <h2>我的任务</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {loading ? (
                <div className={styles.emptyState}>加载中…</div>
              ) : pendingReqs.length === 0 ? (
                <div className={styles.emptyState}>暂无待处理任务</div>
              ) : (
                <div className={styles.compactList}>
                  {pendingReqs.slice(0, 3).map(req => (
                    <button
                      key={req.id}
                      onClick={() => router.push(`/production/${productionId}/tasks/${req.id}`)}
                    >
                      <span className={styles.compactLabel}>
                        <b>{req.title}</b>
                        <small>{req.eventTitle}</small>
                      </span>
                      <span className={`${styles.badge} ${req.status === "in_progress" ? styles.badgeBlue : ""}`}>
                        {REQ_STATUS_LABEL[req.status] ?? req.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href={`/my/tasks`} className={styles.panelSeeAll}>
                {pendingReqs.length > 3 ? `查看全部 ${pendingReqs.length} 条 →` : "查看所有任务 →"}
              </Link>
            </div>
          </section>

          {/* 报告 */}
          {(() => {
            const pendingDrafts = unreadReports.filter(r => !r.publishedAt);
            return (
              <section className={styles.panel}>
                <div className={styles.panelHeading}>
                  <div>
                    <p className={styles.kicker}>Reports</p>
                    <h2>报告</h2>
                  </div>
                </div>
                <div className={styles.panelBody}>
                  {loading ? (
                    <div className={styles.emptyState}>加载中…</div>
                  ) : pendingDrafts.length === 0 ? (
                    <div className={styles.emptyState}>暂无待完成报告</div>
                  ) : (
                    <div className={styles.compactList}>
                      {pendingDrafts.slice(0, 3).map(r => (
                        <button
                          key={r.reportId}
                          onClick={() => router.push(`/production/${productionId}/reports/${r.reportId}`)}
                        >
                          <span className={styles.compactLabel}>
                            <b>{r.reportTitle}</b>
                            <small>{r.eventTitle}</small>
                          </span>
                          <span style={{ fontSize: 10, color: "var(--stage)", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                            待完成
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <Link href={`/production/${productionId}/reports`} className={styles.panelSeeAll}>
                    {pendingDrafts.length > 3 ? `查看全部 ${pendingDrafts.length} 篇待完成 →` : "查看所有报告 →"}
                  </Link>
                </div>
              </section>
            );
          })()}

        </div>
      </div>
    </div>
  );
}
