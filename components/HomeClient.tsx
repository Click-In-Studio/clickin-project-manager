"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { fmtCallAt, isoCSTDateStr, todayCSTStr as tzTodayCSTStr, fmtDate } from "@/lib/tz";
import type { MyCallTimeEntry, MyPendingTechReqEntry, MyFollowedEventEntry, UnreadReportEntry } from "@/lib/event-db";
import styles from "./home.module.css";

function cstDateStr(iso: string): string { return isoCSTDateStr(iso); }
function todayCSTStr(): string { return tzTodayCSTStr(); }

type Production = { id: string; name: string; createdAt: string; archivedAt: string | null; sortOrder: number };

type Props = {
  productions: Production[];
  isAdmin: boolean;
  myCallTimes: MyCallTimeEntry[];
  myPendingReqs: MyPendingTechReqEntry[];
  myFollowedEvents: MyFollowedEventEntry[];
  myUnreadReports: UnreadReportEntry[];
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
};

export default function HomeClient({ productions: initial, isAdmin, myCallTimes, myPendingReqs, myFollowedEvents, myUnreadReports }: Props) {
  const router = useRouter();
  const [productions, setProductions] = useState<Production[]>(initial);
  const [callView, setCallView] = useState<"today" | "week">("today");

  const today = todayCSTStr();

  const activeProductions = productions.filter(p => !p.archivedAt);

  // Call times: filter for today or show full week
  const todayCalls = myCallTimes.filter(ct => cstDateStr(ct.callAt) === today);
  const displayCalls = callView === "today" ? todayCalls : myCallTimes;

  const callsByDate = new Map<string, MyCallTimeEntry[]>();
  for (const ct of displayCalls) {
    const d = cstDateStr(ct.callAt);
    if (!callsByDate.has(d)) callsByDate.set(d, []);
    callsByDate.get(d)!.push(ct);
  }

  return (
    <div className={styles.workspace}>
      {/* Page header */}
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>平台级</p>
        <h1 className={styles.pageTitle}>我的工作</h1>
      </div>

      <div className={styles.contentStack}>

        {/* 1. 项目风险与未确认事项 */}
        <section className={styles.alertBanner}>
          <div className={styles.alertBannerContent}>
            <p className={styles.alertEyebrow}>Alerts · Announcements</p>
            <h2>项目风险与未确认事项</h2>
            <div className={styles.alertEmpty}>
              暂无风险提醒或公告 · 风险警告与演出公告将在这里汇总
            </div>
          </div>
        </section>

        {/* Dashboard: left (wide) + right (narrow) columns */}
        <div className={styles.dashboardGrid}>
          <div className={styles.dashboardCol}>

          {/* 2. 今天 / 本周 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>My Schedule</p>
                <h2>{callView === "today" ? "今天" : "本周"}</h2>
              </div>
              <div className={styles.viewToggle}>
                <button aria-pressed={callView === "today"} onClick={() => setCallView("today")}>今天</button>
                <button aria-pressed={callView === "week"} onClick={() => setCallView("week")}>本周</button>
              </div>
            </div>

            <div className={styles.panelBody}>
              {displayCalls.length === 0 ? (
                <div className={styles.emptyState}>
                  {callView === "today" ? "今天暂无 Call" : "本周暂无 Call"}
                </div>
              ) : (
                <div className={styles.timelineList}>
                  {displayCalls.slice(0, 3).map(ct => (
                    <button
                      key={ct.id}
                      onClick={() => router.push(`/production/${ct.productionId}/events/${ct.eventId}/callsheet`)}
                    >
                      <time>{fmtCallAt(ct.callAt)}</time>
                      <span className={styles.timelineLabel}>
                        <b>{ct.eventTitle}</b>
                        <small>
                          {ct.productionName}
                          {ct.eventLocation ? ` · ${ct.eventLocation}` : ""}
                          {ct.notes ? ` · ${ct.notes}` : ""}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href="/my/weekly-call" className={styles.panelSeeAll}>
                {displayCalls.length > 3 ? `查看全部 ${displayCalls.length} 条 →` : "查看完整日程 →"}
              </Link>
            </div>
          </section>

          </div>{/* end left col */}
          <div className={styles.dashboardCol}>

          {/* 3. 我的 Task */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>My Tasks</p>
                <h2>我的 Task</h2>
              </div>
            </div>

            <div className={styles.panelBody}>
              {myPendingReqs.length === 0 ? (
                <div className={styles.emptyState}>暂无待处理任务</div>
              ) : (
                <div className={styles.compactList}>
                  {myPendingReqs.slice(0, 3).map(req => (
                    <button
                      key={req.id}
                      onClick={() => router.push(`/production/${req.productionId}/events/${req.eventId}/reqs/${req.id}`)}
                    >
                      <span className={styles.compactLabel}>
                        <b>{req.title}</b>
                        <small>{req.eventTitle} · {req.productionName}</small>
                      </span>
                      <span className={`${styles.badge} ${req.status === "in_progress" ? styles.badgeBlue : ""}`}>
                        {STATUS_LABEL[req.status] ?? req.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href="/my/tasks" className={styles.panelSeeAll}>
                {myPendingReqs.length > 3 ? `查看全部 ${myPendingReqs.length} 条 →` : "查看全部任务 →"}
              </Link>
            </div>
          </section>

          {/* 4. 待确认 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>Action Required</p>
                <h2>待确认</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              <div className={styles.emptyDashed}>
                暂无待确认事项
                <small>通知回复与审批流开发中</small>
              </div>
              <Link href="/my/notifications" className={styles.panelSeeAll}>
                查看通知 →
              </Link>
            </div>
          </section>

          {/* 5. 未读报告 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>Unread Reports</p>
                <h2>未读报告</h2>
              </div>
            </div>

            <div className={styles.panelBody}>
              {myUnreadReports.length === 0 ? (
                <div className={styles.emptyState}>暂无未读报告</div>
              ) : (
                <div className={styles.compactList}>
                  {myUnreadReports.slice(0, 3).map(r => (
                    <button
                      key={r.reportId}
                      onClick={() => router.push(`/production/${r.productionId}/events/${r.eventId}/reports/${r.reportId}`)}
                    >
                      <span className={styles.compactLabel}>
                        <b>{r.reportTitle}</b>
                        <small>{r.eventTitle} · {r.productionName}</small>
                      </span>
                      <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
                        {fmtDate(r.publishedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href="/my/reports" className={styles.panelSeeAll}>
                {myUnreadReports.length > 3 ? `查看全部 ${myUnreadReports.length} 篇未读 →` : "查看所有报告 →"}
              </Link>
            </div>
          </section>

          {/* 6. 我的项目 */}
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.kicker}>My Productions</p>
                <h2>我的项目</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {activeProductions.length === 0 ? (
                <div className={styles.emptyState}>暂无进行中项目</div>
              ) : (
                <div className={styles.compactList}>
                  {activeProductions.slice(0, 3).map(p => (
                    <button
                      key={p.id}
                      onClick={() => router.push(`/production/${p.id}`)}
                    >
                      <span className={styles.compactLabel}>
                        <b>{p.name}</b>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <Link href="/my/projects" className={styles.panelSeeAll}>
                {activeProductions.length > 3 ? `查看全部 ${productions.length} 个项目 →` : "管理项目 →"}
              </Link>
            </div>
          </section>

          </div>{/* end right col */}
        </div>{/* end dashboardGrid */}

      </div>
    </div>
  );
}
