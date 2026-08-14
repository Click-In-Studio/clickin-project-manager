"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { MyTechReqFullEntry } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";
import styles from "@/components/my-pages.module.css";

const STATUS_LABEL: Record<string, string> = {
  awaiting: "待确认",
  pending: "待处理",
  in_progress: "进行中",
  done: "完成",
};

function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === "awaiting") return { background: "#f3eeff", color: "#7c3aed" };
  if (status === "pending") return { background: "#fffbeb", color: "#d97706" };
  if (status === "in_progress") return { background: "#eff6ff", color: "#2563eb" };
  if (status === "done") return { background: "#f0fdf4", color: "#16a34a" };
  return { background: "var(--surface-2)", color: "var(--muted)" };
}

type StatusFilter = "active" | "awaiting" | "pending" | "in_progress" | "done";

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  active: "进行中任务",
  awaiting: "待确认",
  pending: "待处理",
  in_progress: "进行中",
  done: "已完成",
};

const VALID_STATUSES = ["awaiting", "pending", "in_progress", "done"] as const;

export default function MyTasksClient() {
  const [tasks, setTasks] = useState<MyTechReqFullEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [selectedProduction, setSelectedProduction] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [selected, setSelected] = useState<MyTechReqFullEntry | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/my/tasks`)
      .then(r => r.json())
      .then((data: MyTechReqFullEntry[]) => {
        setTasks(data);
        setLoading(false);
        const first = data.find(t => t.status !== "done");
        setSelected(first ?? data[0] ?? null);
      })
      .catch(() => setLoading(false));
  }, []);

  async function updateStatus(task: MyTechReqFullEntry, newStatus: string) {
    setUpdating(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${task.productionId}/events/${task.eventId}/tech-reqs/${task.id}/status`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: newStatus }) }
      );
      if (!res.ok) return;
      const patch = { ...task, status: newStatus };
      setTasks(prev => prev.map(t => t.id === task.id ? patch : t));
      setSelected(prev => prev?.id === task.id ? patch : prev);
    } finally {
      setUpdating(false);
    }
  }

  const productions = Array.from(
    new Map(tasks.map(t => [t.productionId, t.productionName])).entries()
  );

  const filtered = tasks.filter(t => {
    if (selectedProduction !== "all" && t.productionId !== selectedProduction) return false;
    if (statusFilter === "active") return t.status !== "done";
    return t.status === statusFilter;
  });

  const visibleSelected = filtered.find(t => t.id === selected?.id) ?? null;

  // Cross-filter counts: each dimension counts with the OTHER dimension's active filter applied
  const countForProd = (prodId: string | "all") => tasks.filter(t => {
    const prodMatch = prodId === "all" || t.productionId === prodId;
    if (!prodMatch) return false;
    if (statusFilter === "active") return t.status !== "done";
    return t.status === statusFilter;
  }).length;

  const countFor = (sf: StatusFilter) => tasks.filter(t => {
    const prodMatch = selectedProduction === "all" || t.productionId === selectedProduction;
    if (!prodMatch) return false;
    if (sf === "active") return t.status !== "done";
    return t.status === sf;
  }).length;

  if (loading) {
    return (
      <div className={styles.workspace}>
        <div className={styles.pageHeader}>
          <p className={styles.eyebrow}>Platform · 任务</p>
          <h1 className={styles.pageTitle}>我的任务</h1>
        </div>
        <div className={styles.emptyState}>加载中…</div>
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Platform · 任务</p>
        <h1 className={styles.pageTitle}>我的任务</h1>
      </div>

      {/* ── 摘要统计（通知提醒同款语汇）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(tasks.filter(t => t.status === "pending" || t.status === "awaiting").length), "待处理", "含待确认"],
          [String(tasks.filter(t => t.status === "in_progress").length), "进行中", "跨项目推进"],
          [String(tasks.filter(t => t.status === "done").length), "已完成", `共 ${tasks.length} 项`],
        ].map(([num, label, hint]) => (
          <div key={label} style={{
            minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13,
            background: "var(--surface)",
          }}>
            <span style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, color: "var(--ink)" }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      {/* ── Panel（统一定高）── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      {tasks.length === 0 ? (
        <div className={styles.emptyState}>
          暂无与我相关的任务
          <small>被指派或负责部门有需求时会在这里显示</small>
        </div>
      ) : (
        <>
          {/* ── Mobile: filter chips + accordion list ── */}
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
                  <option value="all">所有演出 ({countForProd("all")})</option>
                  {productions.map(([id, name]) => (
                    <option key={id} value={id}>{name} ({countForProd(id)})</option>
                  ))}
                </select>
              )}
              <div className={styles.mobileTaskStatusScroll}>
                {(["active", "awaiting", "pending", "in_progress", "done"] as StatusFilter[]).map(sf => (
                  <button
                    key={sf}
                    onClick={() => setStatusFilter(sf)}
                    className={`${styles.mobileTaskChip} ${statusFilter === sf ? styles.active : ""}`}
                  >
                    {STATUS_FILTER_LABELS[sf]} ({countFor(sf)})
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className={styles.emptyState}>无匹配任务</div>
            ) : (
              <div className={styles.mobileTaskList}>
                {filtered.map(t => {
                  const isExpanded = selected?.id === t.id;
                  return (
                    <div key={t.id} className={styles.mobileTaskCard}>
                      <button
                        onClick={() => setSelected(isExpanded ? null : t)}
                        className={styles.mobileTaskCardBtn}
                      >
                        <div className={styles.mobileTaskCardMeta}>
                          <span className={styles.mobileTaskCardKicker}>
                            {t.productionName} · {t.eventTitle}
                            {t.departmentName && ` · ${t.departmentName}`}
                          </span>
                          <span style={{
                            flexShrink: 0, borderRadius: 6, padding: "3px 8px",
                            fontSize: 10, fontWeight: 700, ...statusBadgeStyle(t.status),
                          }}>
                            {STATUS_LABEL[t.status] ?? t.status}
                          </span>
                        </div>
                        <p className={`${styles.mobileTaskCardTitle} ${isExpanded ? "" : styles.mobileTaskCardTitleClamp}`}>
                          {t.title || "待填写需求名称…"}
                        </p>
                        {t.assignees.length > 0 && (
                          <p className={styles.mobileTaskCardAssignees}>
                            {t.assignees.map(a => a.name).join("、")}
                          </p>
                        )}
                      </button>

                      {isExpanded && (
                        <div className={styles.mobileTaskCardDetail}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                            <span style={{ fontSize: 11, color: "var(--muted)" }}>更新状态</span>
                            <select
                              disabled={updating}
                              value={t.status}
                              onChange={e => updateStatus(t, e.target.value)}
                              style={{
                                borderRadius: 6, padding: "4px 8px",
                                fontSize: 11, fontWeight: 700, cursor: "pointer",
                                border: "1px solid transparent", outline: "none",
                                opacity: updating ? 0.5 : 1,
                                ...statusBadgeStyle(t.status),
                              }}
                            >
                              {VALID_STATUSES.map(s => (
                                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                              ))}
                            </select>
                          </div>

                          {t.departmentName && (
                            <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                              部门：{t.departmentName}
                            </p>
                          )}
                          {t.assignees.length > 0 && (
                            <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
                              负责人：{t.assignees.map(a => a.name).join("、")}
                            </p>
                          )}

                          {t.description && (
                            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 14 }}>
                              <SmartText content={t.description} plugins={[scriptRefTextPlugin]} productionId={t.productionId} />
                            </div>
                          )}

                          {t.deptPeople.length > 0 && (
                            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 14 }}>
                              <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                                部门成员
                              </p>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                {t.deptPeople.map(p => (
                                  <span key={p.userId} style={{
                                    fontSize: 12, padding: "4px 10px", borderRadius: 6,
                                    background: "var(--surface-2)", color: "var(--ink)",
                                  }}>
                                    {p.name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          <Link
                            href={`/production/${t.productionId}/tasks/${t.id}`}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 6,
                              border: "1px solid var(--ink)", borderRadius: 8, padding: "9px 18px",
                              fontSize: 12, fontWeight: 700, color: "var(--ink)", textDecoration: "none",
                            }}
                          >
                            前往任务详情 →
                          </Link>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Desktop: 3-column layout ── */}
          <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 380px", gap: 0, height: "100%", minHeight: 0 }}>
              {/* Left: filters */}
              <div style={{ borderRight: "1px solid var(--line)", padding: "0 16px 24px 0", overflowY: "auto" }}>
                <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 8px" }}>演出</h3>
                <div className={styles.filterList}>
                  <button
                    className={`${styles.filterItem} ${selectedProduction === "all" ? styles.active : ""}`}
                    onClick={() => setSelectedProduction("all")}
                  >
                    <span>全部</span>
                    <span className={styles.filterCount}>{countForProd("all")}</span>
                  </button>
                  {productions.map(([id, name]) => (
                    <button
                      key={id}
                      className={`${styles.filterItem} ${selectedProduction === id ? styles.active : ""}`}
                      onClick={() => setSelectedProduction(id)}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                      <span className={styles.filterCount}>{countForProd(id)}</span>
                    </button>
                  ))}
                </div>

                <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "20px 0 8px" }}>状态</h3>
                <div className={styles.filterList}>
                  {(["active", "awaiting", "pending", "in_progress", "done"] as StatusFilter[]).map(sf => (
                    <button
                      key={sf}
                      className={`${styles.filterItem} ${statusFilter === sf ? styles.active : ""}`}
                      onClick={() => setStatusFilter(sf)}
                    >
                      <span>{STATUS_FILTER_LABELS[sf]}</span>
                      <span className={styles.filterCount}>{countFor(sf)}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Middle: task list */}
              <div style={{ borderRight: "1px solid var(--line)", overflowY: "auto", padding: "0 0 24px 20px" }}>
                {filtered.length === 0 ? (
                  <div className={styles.emptyState} style={{ paddingTop: 60 }}>无匹配任务</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {filtered.map(t => {
                      const isSelected = selected?.id === t.id;
                      return (
                        <button
                          key={t.id}
                          onClick={() => setSelected(t)}
                          style={{
                            border: "1px solid " + (isSelected ? "var(--ink)" : "transparent"),
                            borderRadius: 10, padding: "13px 16px",
                            background: isSelected ? "var(--ink)" : "transparent",
                            cursor: "pointer", textAlign: "left", width: "100%",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{
                                margin: "0 0 4px", fontSize: 10, fontWeight: 700,
                                letterSpacing: ".08em", textTransform: "uppercase",
                                color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)",
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }}>
                                {t.productionName} · {t.eventTitle}
                                {t.departmentName && ` · ${t.departmentName}`}
                              </p>
                              <p style={{
                                margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.35,
                                color: isSelected ? "#fff" : "var(--ink)",
                                display: "-webkit-box", WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical", overflow: "hidden",
                              }}>
                                {t.title || "待填写需求名称…"}
                              </p>
                              {t.assignees.length > 0 && (
                                <p style={{ margin: "4px 0 0", fontSize: 11, color: isSelected ? "rgba(255,255,255,.5)" : "var(--muted)" }}>
                                  {t.assignees.map(a => a.name).join("、")}
                                </p>
                              )}
                            </div>
                            <span style={{
                              flexShrink: 0, borderRadius: 6, padding: "3px 8px",
                              fontSize: 10, fontWeight: 700,
                              ...(isSelected
                                ? { background: "rgba(255,255,255,.15)", color: "rgba(255,255,255,.8)" }
                                : statusBadgeStyle(t.status)),
                            }}>
                              {STATUS_LABEL[t.status] ?? t.status}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right: detail */}
              <div style={{ overflowY: "auto", padding: "0 0 24px 24px" }}>
                {!visibleSelected ? (
                  <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                    选择左侧任务查看详情
                  </div>
                ) : (
                  <div>
                    <div style={{ marginBottom: 18 }}>
                      <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                        {visibleSelected.productionName} · {visibleSelected.eventTitle}
                      </p>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                        <h2 style={{
                          margin: 0, flex: 1,
                          fontFamily: 'Georgia, "Noto Serif SC", serif',
                          fontSize: "clamp(18px, 1.8vw, 24px)", fontWeight: 500, color: "var(--ink)",
                          lineHeight: 1.3,
                        }}>
                          {visibleSelected.title || "待填写需求名称…"}
                        </h2>
                        <select
                          disabled={updating}
                          value={visibleSelected.status}
                          onChange={e => updateStatus(visibleSelected, e.target.value)}
                          style={{
                            flexShrink: 0, borderRadius: 6, padding: "4px 8px",
                            fontSize: 11, fontWeight: 700, cursor: "pointer",
                            border: "1px solid transparent", outline: "none",
                            opacity: updating ? 0.5 : 1,
                            ...statusBadgeStyle(visibleSelected.status),
                          }}
                        >
                          {VALID_STATUSES.map(s => (
                            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                      </div>

                      {visibleSelected.departmentName && (
                        <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                          部门：{visibleSelected.departmentName}
                        </p>
                      )}
                      {visibleSelected.assignees.length > 0 && (
                        <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                          负责人：{visibleSelected.assignees.map(a => a.name).join("、")}
                        </p>
                      )}
                    </div>

                    {visibleSelected.description && (
                      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 18, marginBottom: 20 }}>
                        <SmartText content={visibleSelected.description} plugins={[scriptRefTextPlugin]} productionId={visibleSelected.productionId} />
                      </div>
                    )}

                    {visibleSelected.deptPeople.length > 0 && (
                      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, marginBottom: 20 }}>
                        <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                          部门成员
                        </p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {visibleSelected.deptPeople.map(p => (
                            <span key={p.userId} style={{
                              fontSize: 12, padding: "4px 10px", borderRadius: 6,
                              background: "var(--surface-2)", color: "var(--ink)",
                            }}>
                              {p.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <Link
                      href={`/production/${visibleSelected.productionId}/tasks/${visibleSelected.id}`}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        border: "1px solid var(--ink)",
                        borderRadius: 8, padding: "9px 18px",
                        fontSize: 12, fontWeight: 700, color: "var(--ink)",
                        textDecoration: "none",
                      }}
                    >
                      前往任务详情 →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      </section>
    </div>
  );
}