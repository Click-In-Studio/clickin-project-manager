"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { MyReportEntry } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import styles from "@/components/my-pages.module.css";

const TYPE_LABEL: Record<string, string> = {
  production: "Production",
  daily: "Daily",
  tech: "Tech",
  rehearsal: "Rehearsal",
};

function fmtDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function typeBadgeStyle(type: string) {
  if (type === "production") return { background: "#f2e4d9", color: "var(--stage)" };
  if (type === "daily") return { background: "#dce9e9", color: "var(--script)" };
  return { background: "var(--surface-2)", color: "var(--muted)" };
}

export default function ReportsClient() {
  const [reports, setReports] = useState<MyReportEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProduction, setSelectedProduction] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");

  useEffect(() => {
    fetch(`${BASE_PATH}/api/my/reports`)
      .then(r => r.json())
      .then(data => { setReports(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const productions = Array.from(
    new Map(reports.map(r => [r.productionId, r.productionName])).entries()
  );

  const typeOptions = Array.from(new Set(reports.map(r => r.reportType)));

  const filtered = reports.filter(r => {
    if (selectedProduction !== "all" && r.productionId !== selectedProduction) return false;
    if (selectedType !== "all" && r.reportType !== selectedType) return false;
    return true;
  });

  const unreadCount = reports.filter(r => !r.isRead).length;

  if (loading) {
    return (
      <div className={styles.workspace}>
        <div className={styles.pageHeader}>
          <p className={styles.eyebrow}>Platform · 报告</p>
          <h1 className={styles.pageTitle}>报告</h1>
        </div>
        <div className={styles.emptyState}>加载中…</div>
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Platform · 报告</p>
        <h1 className={styles.pageTitle}>报告</h1>
      </div>

      {reports.length === 0 ? (
        <div className={styles.emptyState}>
          暂无可查看的报告
          <small>参与演出并有报告发布时会在这里显示</small>
        </div>
      ) : (
        <>
          {/* ── Mobile: filter chips + card list ── */}
          <div className={styles.mobileOnly}>
            <div className={styles.mobileTaskFilterBar}>
              {productions.length > 1 && (
                <select
                  value={selectedProduction}
                  onChange={e => setSelectedProduction(e.target.value)}
                  style={{
                    width: "100%", border: "1px solid var(--line)", borderRadius: 8,
                    padding: "8px 12px", fontSize: 12, color: "var(--ink)",
                    background: "var(--surface)", outline: "none", cursor: "pointer",
                  }}
                >
                  <option value="all">所有演出 ({reports.length})</option>
                  {productions.map(([id, name]) => (
                    <option key={id} value={id}>{name} ({reports.filter(r => r.productionId === id).length})</option>
                  ))}
                </select>
              )}
              {typeOptions.length > 1 && (
                <div className={styles.mobileTaskStatusScroll}>
                  <button
                    onClick={() => setSelectedType("all")}
                    className={`${styles.mobileTaskChip} ${selectedType === "all" ? styles.active : ""}`}
                  >
                    全部类型
                  </button>
                  {typeOptions.map(t => (
                    <button
                      key={t}
                      onClick={() => setSelectedType(t)}
                      className={`${styles.mobileTaskChip} ${selectedType === t ? styles.active : ""}`}
                    >
                      {TYPE_LABEL[t] ?? t}
                    </button>
                  ))}
                </div>
              )}
              {unreadCount > 0 && (
                <p style={{ margin: 0, fontSize: 11, color: "var(--script)", fontWeight: 700 }}>
                  {unreadCount} 篇未读
                </p>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className={styles.emptyState}>无匹配报告</div>
            ) : (
              <div className={styles.mobileTaskList}>
                {filtered.map(r => (
                  <Link
                    key={r.reportId}
                    href={`/production/${r.productionId}/reports/${r.reportId}`}
                    className={`${styles.mobileReportItem} ${!r.isRead ? styles.unread : ""}`}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 5 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.eventTitle}
                      </span>
                      <span className={styles.badge} style={typeBadgeStyle(r.reportType)}>
                        {TYPE_LABEL[r.reportType] ?? r.reportType}
                      </span>
                    </div>
                    <p style={{ margin: "0 0 5px", fontSize: 13, fontWeight: !r.isRead ? 700 : 600, color: "var(--ink)", lineHeight: 1.35, display: "flex", alignItems: "center", gap: 7 }}>
                      {!r.isRead && <span className={styles.unreadDot} />}
                      {r.title}
                    </p>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>{fmtDate(r.publishedAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* ── Desktop: sidebar + table ── */}
          <div className={styles.desktopOnly}>
            <div className={styles.wideContent}>
              <div className={styles.sideFilters}>
                <h3>演出</h3>
                <div className={styles.filterList}>
                  <button
                    className={`${styles.filterItem} ${selectedProduction === "all" ? styles.active : ""}`}
                    onClick={() => setSelectedProduction("all")}
                  >
                    <span>全部</span>
                    <span className={styles.filterCount}>{reports.length}</span>
                  </button>
                  {productions.map(([id, name]) => (
                    <button
                      key={id}
                      className={`${styles.filterItem} ${selectedProduction === id ? styles.active : ""}`}
                      onClick={() => setSelectedProduction(id)}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                      <span className={styles.filterCount}>{reports.filter(r => r.productionId === id).length}</span>
                    </button>
                  ))}
                </div>

                {typeOptions.length > 1 && (
                  <>
                    <h3 style={{ marginTop: 20 }}>类型</h3>
                    <div className={styles.filterList}>
                      <button
                        className={`${styles.filterItem} ${selectedType === "all" ? styles.active : ""}`}
                        onClick={() => setSelectedType("all")}
                      >全部</button>
                      {typeOptions.map(t => (
                        <button
                          key={t}
                          className={`${styles.filterItem} ${selectedType === t ? styles.active : ""}`}
                          onClick={() => setSelectedType(t)}
                        >
                          {TYPE_LABEL[t] ?? t}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {unreadCount > 0 && (
                  <p style={{ marginTop: 18, fontSize: 11, color: "var(--script)", fontWeight: 700 }}>
                    {unreadCount} 篇未读
                  </p>
                )}
              </div>

              <div>
                {filtered.length === 0 ? (
                  <div className={styles.emptyState}>无匹配报告</div>
                ) : (
                  <div className={styles.reportTable}>
                    <div className={styles.reportTableHead}>
                      <span>标题</span>
                      <span>Event</span>
                      <span>类型</span>
                      <span>发布时间</span>
                    </div>
                    <div>
                      {filtered.map(r => (
                        <Link
                          key={r.reportId}
                          href={`/production/${r.productionId}/reports/${r.reportId}`}
                          className={`${styles.reportRow} ${!r.isRead ? styles.unread : ""}`}
                        >
                          <div className={styles.reportTitle}>
                            {!r.isRead && <span className={styles.unreadDot} />}
                            <span>{r.title}</span>
                          </div>
                          <div className={styles.reportEvent}>{r.eventTitle}</div>
                          <div>
                            <span className={styles.badge} style={typeBadgeStyle(r.reportType)}>
                              {TYPE_LABEL[r.reportType] ?? r.reportType}
                            </span>
                          </div>
                          <div className={styles.reportDate}>{fmtDate(r.publishedAt)}</div>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
