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

/** 状态徽章：主题色板（原型 notes 紫 / warn / script 青 / success 绿） */
function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === "awaiting") return { background: "#eee5f0", color: "#7a5a86" };
  if (status === "pending") return { background: "var(--warn-soft)", color: "var(--warn)" };
  if (status === "in_progress") return { background: "var(--script-soft)", color: "var(--script)" };
  if (status === "done") return { background: "var(--success-soft)", color: "var(--success)" };
  return { background: "var(--paper)", color: "var(--muted)" };
}

/** 截止展示：有效结束时间（自身→绑定日程→事件解析链）；过期红、今日警示 */
function dueInfo(t: ProductionTechReqEntry): { label: string; style: React.CSSProperties } | null {
  const iso = t.effectiveEndTime;
  if (!iso) return null;
  const d = new Date(iso);
  const label = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (t.status === "done") return { label, style: { color: "var(--muted)" } };
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (d.getTime() < now.getTime() && !sameDay)
    return { label: `${label} 已逾期`, style: { color: "var(--danger)", fontWeight: 700 } };
  if (sameDay)
    return { label: `${label} 今日截止`, style: { color: "var(--warn)", fontWeight: 700 } };
  return { label, style: { color: "var(--muted)" } };
}

const isBlockedActive = (t: ProductionTechReqEntry) => t.isBlocked && t.status !== "done";

function BlockedChip() {
  return (
    <span style={{
      flexShrink: 0, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700,
      background: "var(--danger-soft)", color: "var(--danger)",
    }}>
      ⛔ 受阻
    </span>
  );
}

/** 关系行文案：关联事件 / 独立任务（event 绑定可选后 eventTitle 可空） */
function relationLabel(t: ProductionTechReqEntry): string {
  const base = t.eventTitle ?? "独立任务";
  return t.departmentName ? `${base} · ${t.departmentName}` : base;
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
  // 三 scope（原型）：我的 / 全部 / 按事件（仅看关联了事件的 Task）。
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
        `${BASE_PATH}/api/production/${productionId}/tasks/${task.id}/status`,
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

  const events = Array.from(new Map(
    tasks.filter(t => t.eventId != null).map(t => [t.eventId!, t.eventTitle ?? ""] as [string, string])
  ).entries());
  const depts = Array.from(
    new Map(tasks.filter(t => t.departmentId).map(t => [t.departmentId!, t.departmentName!])).entries()
  );

  const hasStandalone = tasks.some(t => !t.eventId);

  const filtered = tasks.filter(t => {
    if (scope === "mine" && !(currentUserId && t.assignees.some(a => a.userId === currentUserId))) return false;
    if (scope === "event" && !t.eventId) return false;  // 仅看关联事件的
    if (selectedEvent === "__standalone" ? t.eventId != null : (selectedEvent !== "all" && t.eventId !== selectedEvent)) return false;
    if (selectedDept !== "all" && t.departmentId !== selectedDept) return false;
    if (statusFilter === "active") return t.status !== "done";
    return t.status === statusFilter;
  });

  // 摘要统计（原型 taskSummary：待处理 / 进行中 / 已阻塞 / 完成度）
  const todayStr = new Date().toDateString();
  const dueToday = tasks.filter(t =>
    t.status !== "done" && t.effectiveEndTime && new Date(t.effectiveEndTime).toDateString() === todayStr
  ).length;
  const summary = {
    pending: tasks.filter(t => t.status === "pending" || t.status === "awaiting").length,
    inProgress: tasks.filter(t => t.status === "in_progress").length,
    blocked: tasks.filter(isBlockedActive).length,
    done: tasks.filter(t => t.status === "done").length,
  };
  const inProgressDepts = new Set(
    tasks.filter(t => t.status === "in_progress" && t.departmentId).map(t => t.departmentId)
  ).size;
  // 本周完成度（原型：按 Task 状态统计）：本周到期（有效结束时间落在周一～周日）的任务中已完成占比
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);
  const weekTasks = tasks.filter(t => {
    if (!t.effectiveEndTime) return false;
    const d = new Date(t.effectiveEndTime);
    return d >= weekStart && d < weekEnd;
  });
  const weekDone = weekTasks.filter(t => t.status === "done").length;
  const weekPct = weekTasks.length > 0 ? `${Math.round((weekDone / weekTasks.length) * 100)}%` : "—";
  const weekHint = weekTasks.length > 0
    ? `本周到期 ${weekTasks.length} 项 · 完成 ${weekDone}`
    : "本周无到期任务";

  const visibleSelected = filtered.find(t => t.id === selected?.id) ?? null;

  function countFor(sf: StatusFilter, eventId = selectedEvent, deptId = selectedDept) {
    return tasks.filter(t => {
      if (eventId === "__standalone" ? t.eventId != null : (eventId !== "all" && t.eventId !== eventId)) return false;
      if (deptId !== "all" && t.departmentId !== deptId) return false;
      return sf === "active" ? t.status !== "done" : t.status === sf;
    }).length;
  }

  if (tasks.length === 0) {
    return (
      <div className={styles.emptyState}>
        暂无任务
        <small>事件中创建的任务与独立任务都会在这里汇总</small>
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
          [String(summary.pending), "待处理", dueToday > 0 ? `${dueToday} 项今日截止` : "含待认领"],
          [String(summary.inProgress), "进行中", inProgressDepts > 1 ? `跨 ${inProgressDepts} 个部门` : "推进中"],
          [String(summary.blocked), "已阻塞", "等待前置任务"],
          [weekPct, "本周完成度", weekHint],
        ].map(([num, label, hint]) => (
          <div key={label} style={{
            minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13,
            background: "var(--surface)",
          }}>
            <span style={{
              fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28,
              color: label === "已阻塞" && summary.blocked > 0 ? "var(--danger)" : "var(--ink)",
            }}>{num}</span>
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
          任务可独立存在，也可关联事件或里程碑；截止时间取自身设置或继承绑定日程/事件
        </span>
      </div>

      {/* ── Mobile: filter chips + accordion ── */}
      <div className={styles.mobileOnly}>
        <div className={styles.mobileTaskFilterBar}>
          {(events.length + (hasStandalone ? 1 : 0)) > 1 && (
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
              {hasStandalone && (
                <option value="__standalone">独立任务 ({countFor(statusFilter, "__standalone", selectedDept)})</option>
              )}
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
                        {relationLabel(t)}
                      </span>
                      {isBlockedActive(t) && <BlockedChip />}
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
                    {(t.assignees.length > 0 || dueInfo(t)) && (
                      <p className={styles.mobileTaskCardAssignees}>
                        {t.assignees.map(a => a.name).join("、")}
                        {t.assignees.length > 0 && dueInfo(t) && " · "}
                        {dueInfo(t) && <span style={dueInfo(t)!.style}>{dueInfo(t)!.label}</span>}
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
            {(events.length + (hasStandalone ? 1 : 0)) > 1 && (
              <>
                <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 8px" }}>日程</h3>
                <div className={styles.filterList}>
                  <button className={`${styles.filterItem} ${selectedEvent === "all" ? styles.active : ""}`} onClick={() => setSelectedEvent("all")}>
                    <span>全部</span>
                    <span className={styles.filterCount}>{countFor(statusFilter, "all", selectedDept)}</span>
                  </button>
                  {hasStandalone && (
                    <button className={`${styles.filterItem} ${selectedEvent === "__standalone" ? styles.active : ""}`} onClick={() => setSelectedEvent("__standalone")}>
                      <span>独立任务</span>
                      <span className={styles.filterCount}>{countFor(statusFilter, "__standalone", selectedDept)}</span>
                    </button>
                  )}
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

          {/* Middle: task table（原型 taskTableHeader + taskRows，规格照抄见 my-pages.module.css） */}
          <div style={{ borderRight: "1px solid var(--line)", overflowY: "auto", padding: "0 12px 24px 20px" }}>
            {filtered.length === 0 ? (
              <div className={styles.emptyState} style={{ paddingTop: 60 }}>无匹配任务</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div className={styles.taskTableHeader}>
                  <span>状态</span>
                  <span>任务</span>
                  <span>关系</span>
                  <span style={{ textAlign: "right" }}>负责人 / 截止</span>
                </div>
                {filtered.map(t => {
                  const isSelected = visibleSelected?.id === t.id;
                  const isDone = t.status === "done";
                  const due = dueInfo(t);
                  return (
                    <article
                      key={t.id}
                      className={[
                        styles.taskRow,
                        isDone ? styles.taskRowDone : "",
                        isSelected ? styles.taskRowSelected : "",
                      ].filter(Boolean).join(" ")}
                    >
                      {/* 勾选圈（原型 taskCheck）：完成/恢复切换 */}
                      <button
                        aria-label={isDone ? `恢复 ${t.title}` : `完成 ${t.title}`}
                        disabled={updating}
                        onClick={() => updateStatus(t, isDone ? "in_progress" : "done")}
                        className={styles.taskCheckBtn}
                      >
                        {isDone ? "✓" : ""}
                      </button>
                      {/* taskTitleCell：标题 + 状态/受阻 */}
                      <button onClick={() => setSelected(t)} className={styles.taskTitleCell}>
                        <b>{t.title || "待填写需求名称…"}</b>
                        <small style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{
                            borderRadius: 5, padding: "2px 7px", fontWeight: 700,
                            ...statusBadgeStyle(t.status),
                          }}>
                            {STATUS_LABEL[t.status] ?? t.status}
                          </span>
                          {isBlockedActive(t) && (
                            <span style={{
                              borderRadius: 5, padding: "2px 7px", fontWeight: 700,
                              background: "var(--danger-soft)", color: "var(--danger)",
                            }}>
                              ⛔ 受阻
                            </span>
                          )}
                        </small>
                      </button>
                      {/* taskRelation：关联事件直达 / 独立任务 */}
                      {t.eventId ? (
                        <Link href={`/production/${productionId}/events/${t.eventId}`} className={styles.taskRelationCell}>
                          <b>{t.eventTitle}{t.departmentName && ` · ${t.departmentName}`}</b>
                          <small>打开关联事件 →</small>
                        </Link>
                      ) : (
                        <span className={styles.taskRelationCell} style={{ cursor: "default" }}>
                          <b>独立任务{t.departmentName && ` · ${t.departmentName}`}</b>
                          <small>未绑定事件</small>
                        </span>
                      )}
                      {/* taskOwner：右对齐 负责人 / 截止 */}
                      <span className={styles.taskOwnerCell}>
                        <small>{t.assignees.length > 0 ? t.assignees.map(a => a.name).join("、") : "未指派"}</small>
                        <b style={due?.style}>{due?.label ?? "—"}</b>
                      </span>
                    </article>
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
                  {visibleSelected.effectiveStartTime && (
                    <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                      时间：{new Date(visibleSelected.effectiveStartTime).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                      {visibleSelected.effectiveEndTime && (
                        <> — <span style={dueInfo(visibleSelected)?.style}>{dueInfo(visibleSelected)?.label}</span></>
                      )}
                      {!visibleSelected.startTime && <span style={{ fontSize: 10 }}>（继承自{visibleSelected.eventId ? "事件/日程" : "绑定对象"}）</span>}
                    </p>
                  )}
                  {visibleSelected.milestones.length > 0 && (
                    <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      里程碑：
                      {visibleSelected.milestones.map(m => (
                        <span key={m.id} title={m.endDate} style={{
                          borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                          background: "var(--surface-2)", color: "var(--ink)",
                        }}>
                          ◆ {m.name} · {m.endDate.slice(5).replace("-", "/")}
                        </span>
                      ))}
                    </p>
                  )}
                  {isBlockedActive(visibleSelected) && (
                    <p style={{
                      margin: "10px 0 0", padding: "8px 12px", borderRadius: 8,
                      background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12, fontWeight: 600,
                    }}>
                      ⛔ 被前置任务阻塞——前置任务全部完成前建议暂缓推进（详情页可查看/编辑依赖）
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
                  前往任务详情 →
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