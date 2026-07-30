"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { MyCallTimeEntry, MyPendingTechReqEntry, MyPocAwaitingReqEntry, UnreadReportEntry } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import { fmtCallAt, fmtDate } from "@/lib/tz";
import styles from "@/components/home.module.css";

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: "待处理", in_progress: "进行中",
};

type MyWorkData = {
  callTimes: MyCallTimeEntry[];
  pendingReqs: MyPendingTechReqEntry[];
  awaitingReqs: MyPocAwaitingReqEntry[];
  unreadReports: UnreadReportEntry[];
  isArchived: boolean;
};

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

      {/* Announcements banner */}
      <section className={styles.alertBanner} style={{ marginBottom: 18 }}>
        <div className={styles.alertBannerContent}>
          <p className={styles.alertEyebrow}>Alerts · Announcements</p>
          <h2>公告与风险提醒</h2>
          <div className={styles.alertEmpty}>
            暂无风险提醒或公告 · 公告与演出风险警告将在这里汇总
          </div>
        </div>
        <Link
          href={`/my/announcements`}
          style={{
            flexShrink: 0, fontSize: 11, color: "rgba(255,255,255,.5)",
            textDecoration: "none", alignSelf: "flex-start",
          }}
        >
          全部公告 →
        </Link>
      </section>

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
              <Link
                href={`/production/${productionId}/events`}
                className={styles.panelSeeAll}
              >
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
                      <span className={`${styles.badge}`} style={{ background: "#f3eeff", color: "#7c3aed" }}>
                        待确认
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link
                href={`/production/${productionId}/notifications`}
                className={styles.panelSeeAll}
              >
                {awaitingReqs.length > 3 ? `查看全部 ${awaitingReqs.length} 条 →` : "查看通知 →"}
              </Link>
            </div>
          </section>

        </div>
        <div className={styles.dashboardCol}>

          {/* 我的 Task */}
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
              <Link
                href={`/my/tasks`}
                className={styles.panelSeeAll}
              >
                {pendingReqs.length > 3 ? `查看全部 ${pendingReqs.length} 条 →` : "查看所有任务 →"}
              </Link>
            </div>
          </section>

          {/* 待完成报告 */}
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
                  <Link
                    href={`/production/${productionId}/reports`}
                    className={styles.panelSeeAll}
                  >
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
