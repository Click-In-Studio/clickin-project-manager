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
  initialEventFilter,
  currentUserId,
}: {
  productionId: string;
  initialTasks: ProductionTechReqEntry[];
  /** 事件页关联徽章链跳入时的初始筛选（?event=） */
  initialEventFilter?: string;
  /** "我的"scope 判定（assignee 含本人） */
  currentUserId?: string;
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const [updating, setUpdating] = useState(false);
  // 三 scope（原型）：我的 / 全部 / 按事件。
  // "按事件"=仅看关联了事件的 Task——当前数据模型 event_id NOT NULL 恒为全集，
  // 独立 Task 为未来目标（模型放开后此处零改动激活），见列表"独立 Task"分支。
  const [scope, setScope] = useState<"mine" | "all" | "event">("all");
  const [selectedEvent, setSelectedEvent] = useState<string>(
    initialEventFilter && initialTasks.some(t => t.eventId === initialEventFilter) ? initialEventFilter : "all"
  );
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
    if (scope === "mine" && !(currentUserId && t.assignees.some(a => a.userId === currentUserId))) return false;
    if (scope === "event" && !t.eventId) return false;  // 独立 Task（未来模型）排除
    if (selectedEvent !== "all" && t.eventId !== selectedEvent) return false;
    if (selectedDept !== "all" && t.departmentId !== selectedDept) return false;
    if (statusFilter === "active") return t.status !== "done";
    return t.status === statusFilter;
  });

  // 摘要统计（原型 taskSummary）
  const summary = {
    pending: tasks.filter(t => t.status === "pending" || t.status === "awaiting").length,
    inProgress: tasks.filter(t => t.status === "in_progress").length,
    done: tasks.filter(t => t.status === "done").length,
  };
  const summaryTotal = tasks.length || 1;
  const donePct = Math.round((summary.done / summaryTotal) * 100);

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

  const statusFilters: StatusFilter[] = ["active", "awaiting", "pending", "in_progress", "done"];

  return (
    <>
      {/* ── 摘要统计（原型 taskSummary：1px 缝 grid、92px 高、serif 28px 数字）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(summary.pending), "待处理", "含待认领"],
          [String(summary.inProgress), "进行中", "跨部门推进"],
          [String(summary.done), "已完成", `共 ${tasks.length} 项`],
          [`${donePct}%`, "完成度", "按任务状态统计"],
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

      {/* ── Panel（原型排版）：taskToolbar + 三栏（保留现有设计）── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        {/* segmented（原型：surface-2 槽 + ink 选中块） */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, background: "var(--surface-2)", borderRadius: 8, padding: 3 }}>
          {([["mine", "我的任务"], ["all", "全部"], ["event", "关联事件"]] as const).map(([id, label]) => (
            <button key={id} aria-pressed={scope === id} onClick={() => setScope(id)} style={{
              border: 0, borderRadius: 6, padding: "7px 14px", fontSize: 10, fontWeight: 700, cursor: "pointer",
              background: scope === id ? "var(--ink)" : "transparent",
              color: scope === id ? "#fff" : "var(--muted)", transition: "all .1s", whiteSpace: "nowrap",
            }}>{label}</button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>
          任务可关联事件协同推进；独立任务能力规划中
        </span>
      </div>

      {/* ── Mobile: filter chips + accordion ── */}
      <div className={styles.mobileOnly}>
        <div className={styles.mobileTaskFilterBar}>
          {events.length > 1 && (
            <select
              value={selectedEvent}
              onChange={e => setSelectedEvent(e.target.value)}
              style={{
                width: "100%", border: "1px solid var(--line)", borderRadius: 8,
                padding: "8px 12px", fontSize: 12, color: "var(--ink)",
                background: "var(--surface)", outline: "none", cursor: "pointer",
              }}
            >
              <option value="all">所有日程 ({countFor(statusFilter, "all", selectedDept)})</option>
              {events.map(([id, title]) => (
                <option key={id} value={id}>{title} ({countFor(statusFilter, id, selectedDept)})</option>
              ))}
            </select>
          )}
          {depts.length > 0 && (
            <select
              value={selectedDept}
              onChange={e => setSelectedDept(e.target.value)}
              style={{
                width: "100%", border: "1px solid var(--line)", borderRadius: 8,
                padding: "8px 12px", fontSize: 12, color: "var(--ink)",
                background: "var(--surface)", outline: "none", cursor: "pointer",
              }}
            >
              <option value="all">所有部门 ({countFor(statusFilter, selectedEvent, "all")})</option>
              {depts.map(([id, name]) => (
                <option key={id} value={id}>{name} ({countFor(statusFilter, selectedEvent, id)})</option>
              ))}
            </select>
          )}
          <div className={styles.mobileTaskStatusScroll}>
            {statusFilters.map(sf => (
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
                        {t.eventTitle}{t.departmentName && ` · ${t.departmentName}`}
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
                            opacity: updating ? 0.5 : 1, ...statusBadgeStyle(t.status),
                          }}
                        >
                          {VALID_STATUSES.map(s => (
                            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                      </div>
                      {t.assignees.length > 0 && (
                        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
                          负责人：{t.assignees.map(a => a.name).join("、")}
                        </p>
                      )}
                      {t.description && (
                        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 14 }}>
                          <SmartText content={t.description} plugins={[scriptRefTextPlugin]} productionId={productionId} />
                        </div>
                      )}
                      <Link
                        href={`/production/${productionId}/tasks/${t.id}`}
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
              {statusFilters.map(sf => (
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
              <div style={{ display: "flex", flexDirection: "column" }}>
                {filtered.map((t, i) => {
                  const isSelected = visibleSelected?.id === t.id;
                  const isDone = t.status === "done";
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 12,
                        borderTop: i === 0 ? 0 : "1px solid var(--line)",
                        padding: "13px 10px 13px 6px",
                        background: isSelected ? "var(--surface)" : "transparent",
                        boxShadow: isSelected ? "inset 3px 0 0 var(--ink)" : undefined,
                        opacity: isDone ? 0.55 : 1,
                      }}
                    >
                      {/* 勾选圈（原型 taskCheck）：完成/恢复切换 */}
                      <button
                        aria-label={isDone ? `恢复 ${t.title}` : `完成 ${t.title}`}
                        disabled={updating}
                        onClick={() => updateStatus(t, isDone ? "in_progress" : "done")}
                        style={{
                          flexShrink: 0, width: 20, height: 20, marginTop: 2, borderRadius: "50%",
                          border: `1.5px solid ${isDone ? "var(--ink)" : "var(--line)"}`,
                          background: isDone ? "var(--ink)" : "transparent",
                          color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer",
                          display: "grid", placeItems: "center",
                        }}
                      >
                        {isDone ? "✓" : ""}
                      </button>
                      <button
                        onClick={() => setSelected(t)}
                        style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", cursor: "pointer", textAlign: "left", padding: 0 }}
                      >
                        <p style={{
                          margin: "0 0 4px", fontSize: 10, fontWeight: 700,
                          letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {t.eventTitle}{t.departmentName && ` · ${t.departmentName}`}
                        </p>
                        <p style={{
                          margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.35, color: "var(--ink)",
                          textDecoration: isDone ? "line-through" : "none",
                          display: "-webkit-box", WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}>
                          {t.title || "待填写需求名称…"}
                        </p>
                        {t.assignees.length > 0 && (
                          <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--muted)" }}>
                            {t.assignees.map(a => a.name).join("、")}
                          </p>
                        )}
                      </button>
                      <span style={{
                        flexShrink: 0, borderRadius: 6, padding: "3px 8px",
                        fontSize: 10, fontWeight: 700, ...statusBadgeStyle(t.status),
                      }}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </div>
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
                  {/* 关系行：关联事件直达；独立 Task 分支为未来模型预留（当前 event_id 恒非空） */}
                  {visibleSelected.eventId ? (
                    <Link
                      href={`/production/${productionId}/events/${visibleSelected.eventId}`}
                      style={{ display: "inline-block", margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage, var(--muted))", textDecoration: "none" }}
                    >
                      {visibleSelected.eventTitle}{visibleSelected.departmentName && ` · ${visibleSelected.departmentName}`} →
                    </Link>
                  ) : (
                    <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                      独立任务{visibleSelected.departmentName && ` · ${visibleSelected.departmentName}`}
                    </p>
                  )}
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
                        opacity: updating ? 0.5 : 1, ...statusBadgeStyle(visibleSelected.status),
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
      </div>
      </section>
    </>
  );
}