"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProductionTechReqEntry } from "@/lib/event-db";
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
  return { background: "var(--paper)", color: "var(--muted)" };
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

export default function ProductionTasksClient({
  productionId,
  initialTasks,
}: {
  productionId: string;
  initialTasks: ProductionTechReqEntry[];
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const [updating, setUpdating] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string>("all");
  const [selectedDept, setSelectedDept] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [selected, setSelected] = useState<ProductionTechReqEntry | null>(
    () => initialTasks.find(t => t.status !== "done") ?? initialTasks[0] ?? null
  );

  async function updateStatus(task: ProductionTechReqEntry, newStatus: string) {
    setUpdating(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/events/${task.eventId}/tech-reqs/${task.id}/status`,
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

  const events = Array.from(new Map(tasks.map(t => [t.eventId, t.eventTitle])).entries());
  const depts = Array.from(
    new Map(tasks.filter(t => t.departmentId).map(t => [t.departmentId!, t.departmentName!])).entries()
  );

  const filtered = tasks.filter(t => {
    if (selectedEvent !== "all" && t.eventId !== selectedEvent) return false;
    if (selectedDept !== "all" && t.departmentId !== selectedDept) return false;
    if (statusFilter === "active") return t.status !== "done";
    return t.status === statusFilter;
  });

  const visibleSelected = filtered.find(t => t.id === selected?.id) ?? null;

  function countFor(sf: StatusFilter, eventId = selectedEvent, deptId = selectedDept) {
    return tasks.filter(t => {
      if (eventId !== "all" && t.eventId !== eventId) return false;
      if (deptId !== "all" && t.departmentId !== deptId) return false;
      return sf === "active" ? t.status !== "done" : t.status === sf;
    }).length;
  }

  if (tasks.length === 0) {
    return (
      <div className={styles.emptyState}>
        暂无技术需求
        <small>日程中创建技术需求后会在这里汇总</small>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 380px", gap: 0, height: "calc(100vh - 220px)", minHeight: 400 }}>
      {/* Left: filters */}
      <div style={{ borderRight: "1px solid var(--line)", padding: "0 16px 24px 0", overflowY: "auto" }}>
        {events.length > 1 && (
          <>
            <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 8px" }}>日程</h3>
            <div className={styles.filterList}>
              <button className={`${styles.filterItem} ${selectedEvent === "all" ? styles.active : ""}`} onClick={() => setSelectedEvent("all")}>
                <span>全部</span>
                <span className={styles.filterCount}>{countFor(statusFilter, "all", selectedDept)}</span>
              </button>
              {events.map(([id, title]) => (
                <button key={id} className={`${styles.filterItem} ${selectedEvent === id ? styles.active : ""}`} onClick={() => setSelectedEvent(id)}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
                  <span className={styles.filterCount}>{countFor(statusFilter, id, selectedDept)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {depts.length > 0 && (
          <>
            <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "20px 0 8px" }}>部门</h3>
            <div className={styles.filterList}>
              <button className={`${styles.filterItem} ${selectedDept === "all" ? styles.active : ""}`} onClick={() => setSelectedDept("all")}>
                <span>全部</span>
                <span className={styles.filterCount}>{countFor(statusFilter, selectedEvent, "all")}</span>
              </button>
              {depts.map(([id, name]) => (
                <button key={id} className={`${styles.filterItem} ${selectedDept === id ? styles.active : ""}`} onClick={() => setSelectedDept(id)}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                  <span className={styles.filterCount}>{countFor(statusFilter, selectedEvent, id)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "20px 0 8px" }}>状态</h3>
        <div className={styles.filterList}>
          {(["active", "awaiting", "pending", "in_progress", "done"] as StatusFilter[]).map(sf => (
            <button key={sf} className={`${styles.filterItem} ${statusFilter === sf ? styles.active : ""}`} onClick={() => setStatusFilter(sf)}>
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
              const isSelected = visibleSelected?.id === t.id;
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
                        {t.eventTitle}{t.departmentName && ` · ${t.departmentName}`}
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
          <div style={{ paddingTop: 60, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>选择左侧任务查看详情</div>
        ) : (
          <div>
            <div style={{ marginBottom: 18 }}>
              <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                {visibleSelected.eventTitle}{visibleSelected.departmentName && ` · ${visibleSelected.departmentName}`}
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
              {visibleSelected.assignees.length > 0 && (
                <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                  负责人：{visibleSelected.assignees.map(a => a.name).join("、")}
                </p>
              )}
            </div>

            {visibleSelected.description && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 18, marginBottom: 20 }}>
                <SmartText content={visibleSelected.description} plugins={[scriptRefTextPlugin]} productionId={productionId} />
              </div>
            )}

            <Link
              href={`/production/${productionId}/tasks/${visibleSelected.id}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                border: "1px solid var(--ink)", borderRadius: 8, padding: "9px 18px",
                fontSize: 12, fontWeight: 700, color: "var(--ink)", textDecoration: "none",
              }}
            >
              前往需求详情 →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
