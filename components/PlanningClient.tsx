"use client";

/**
 * 计划与日程（v3 原型 planning 三视图）：
 *   ① 项目日历 —— 月历统一展示事件、任务（未绑定 event 的）与里程碑
 *   ② 任务甘特 —— 任务时间条（有效起止：自身→schedule→event 解析链），可拖拽改期
 *   ③ 执行日程 —— 按事件的多部门 rundown（schedule 条目 + 绑定 event 未绑 schedule 的任务）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dateTimeToIso, fmtDate, fmtTime, isoCSTDateStr, todayCSTStr } from "@/lib/tz";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import Badge from "@/components/Badge";
import type { ProductionEvent, EventScheduleItemWithParticipants, EventTechReq } from "@/lib/event-db";
import styles from "@/components/planning.module.css";

type PlanningMilestone = { id: string; name: string; endDate: string };
type PlanningDept = { id: string; name: string };
type PlanningMember = { userId: string; name: string; roles: string[]; departmentIds: string[] };

/** 三视图共用的任务形状（server page 按 task/*@view 全量或"与我相关"降级投喂）。 */
export type PlanningTask = {
  id: string;
  title: string;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  eventId: string | null;
  eventTitle: string | null;
  /** 自身起止（甘特拖拽写回目标） */
  startTime: string | null;
  endTime: string | null;
  /** 有效起止：自身 → 绑定 schedule min/max → event */
  effectiveStartTime: string | null;
  effectiveEndTime: string | null;
  isBlocked: boolean;
  description: string;
};

type Props = {
  productionId: string;
  events: ProductionEvent[];
  tasks: PlanningTask[];
  milestones: PlanningMilestone[];
  departments: PlanningDept[];
  members: PlanningMember[];
};

const TASK_STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};

type QuickCreateKind = "event" | "task";

// 时间一律 CST（UTC+8），不跟浏览器时区走——全库口径见 lib/tz.ts。
// 原实现用 getFullYear/getHours 这类本地方法，非 CST 时区的用户会看到偏移过的
// 时间，而且写回去时把本地时间当成 CST 存，把数据也写歪。

/**
 * 日历格子的 Date → "YYYY-MM-DD"。
 *
 * 格子 Date 一律用 Date.UTC 构造（见 CalendarView 的 cells），所以这里读 UTC 部件
 * 就是那一天本身，**不能再 +8**——格子代表的是「CST 的某一天」这个概念，不是某个
 * 时刻。事件落到哪一格另走 isoCSTDateStr（ISO 时刻 → CST 日期），两者对齐。
 */
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** ISO → CST 的 "HH:mm" */
function hhmm(iso: string): string {
  return fmtTime(iso);
}

// ─── 项目日历 ─────────────────────────────────────────────────────────────────

function QuickCreateModal({ productionId, date, departments, events, onClose }: {
  productionId: string;
  date: string;
  departments: PlanningDept[];
  events: ProductionEvent[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<QuickCreateKind>("event");
  const [title, setTitle] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [eventType, setEventType] = useState("rehearsal");
  const [departmentIds, setDepartmentIds] = useState<Set<string>>(new Set());
  const [allMembers, setAllMembers] = useState(true);
  const [taskEventId, setTaskEventId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid var(--line)",
    borderRadius: 8, background: "var(--paper)", color: "var(--ink)",
    padding: "9px 10px", fontSize: 12,
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    // date 是 CST 日历格子的日期，startTime/endTime 是 CST 时刻——按 CST 解析，
    // 不能交给 new Date() 按浏览器本地时区猜
    const start = dateTimeToIso(date, startTime);
    const end = dateTimeToIso(date, endTime);
    if (end <= start) {
      setError("结束时间必须晚于开始时间");
      setSaving(false);
      return;
    }
    try {
      if (kind === "event") {
        const eventRes = await fetch(`${BASE_PATH}/api/production/${productionId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), eventType, startTime: start, endTime: end }),
        });
        const eventData = await eventRes.json().catch(() => ({}));
        if (!eventRes.ok) throw new Error(eventData.error ?? "事件创建失败");

        const scheduleRes = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventData.event.id}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `${title.trim()} · 执行日程`,
            itemType: eventType === "rehearsal" ? "scene_rehearsal" : eventType === "meeting" ? "meeting" : "custom",
            startTime: start,
            endTime: end,
            departmentIds: allMembers ? [] : [...departmentIds],
            notes: "由项目日历快捷创建并自动关联。",
          }),
        });
        if (!scheduleRes.ok) {
          const scheduleData = await scheduleRes.json().catch(() => ({}));
          throw new Error(`事件已创建，但执行日程生成失败：${scheduleData.error ?? "未知错误"}`);
        }
      } else {
        const taskRes = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            startTime: start,
            endTime: end,
            departmentId: allMembers ? null : [...departmentIds][0] ?? null,
            eventId: taskEventId || null,
            description: "由项目日历快捷创建。",
          }),
        });
        const taskData = await taskRes.json().catch(() => ({}));
        if (!taskRes.ok) throw new Error(taskData.error ?? "任务创建失败");
      }
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${date} 快捷新建`}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(7,29,32,.34)", display: "grid", placeItems: "center", padding: 18 }}
    >
      <form onSubmit={submit} style={{ width: "min(520px, 100%)", maxHeight: "calc(100vh - 36px)", overflowY: "auto", borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)", boxShadow: "0 22px 70px rgba(7,29,32,.24)", padding: 22 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
          <div>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 10, fontWeight: 700, letterSpacing: ".12em" }}>{date}</p>
            <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 22, fontWeight: 500 }}>快捷新建</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto", border: 0, background: "transparent", color: "var(--muted)", fontSize: 22, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 14 }}>
          {([['event', '事件', '自动生成执行日程'], ['task', '任务', '同步进入任务与甘特']] as const).map(([value, label, hint]) => {
            const active = kind === value;
            return (
              <button key={value} type="button" onClick={() => setKind(value)} style={{ border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`, borderRadius: 9, padding: "10px 11px", background: active ? "var(--ink)" : "var(--paper)", color: active ? "#fff" : "var(--ink)", textAlign: "left", cursor: "pointer" }}>
                <b style={{ display: "block", fontSize: 12 }}>{label}</b>
                <small style={{ display: "block", marginTop: 3, color: active ? "#bdcbc7" : "var(--muted)", fontSize: 9 }}>{hint}</small>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 11, color: "var(--muted)" }}>标题
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === "event" ? "例如：第三场合成排练" : "例如：确认无线麦频点"} style={{ ...fieldStyle, display: "block", marginTop: 5 }} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <BoundedTimePicker label="开始时间" value={startTime} onChange={setStartTime} />
            <BoundedTimePicker label="结束时间" value={endTime} onChange={setEndTime} />
          </div>
          {kind === "event" && (
            <label style={{ fontSize: 11, color: "var(--muted)" }}>事件类型
              <select value={eventType} onChange={e => setEventType(e.target.value)} style={{ ...fieldStyle, display: "block", marginTop: 5 }}>
                <option value="rehearsal">排练</option><option value="meeting">会议</option><option value="performance">演出</option><option value="custom">其他</option>
              </select>
            </label>
          )}
          {kind === "task" && (
            <label style={{ fontSize: 11, color: "var(--muted)" }}>关联事件（可选）
              <select value={taskEventId} onChange={e => setTaskEventId(e.target.value)} style={{ ...fieldStyle, display: "block", marginTop: 5 }}>
                <option value="">不关联，建立独立任务</option>
                {events.filter(event => event.status !== "cancelled").map(event => (
                  <option key={event.id} value={event.id}>{event.startTime ? `${new Date(event.startTime).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} · ` : ""}{event.title}</option>
                ))}
              </select>
            </label>
          )}
          <div>
            <span style={{ display: "block", marginBottom: 5, fontSize: 11, color: "var(--muted)" }}>
              {kind === "event" ? "参与部门（可多选）" : "负责部门（任务以第一个选中部门为主责）"}
            </span>
            <div className={styles.multiPicker}>
              <button
                type="button"
                className={`${styles.toggleChip} ${allMembers ? styles.toggleChipActive : ""}`}
                onClick={() => { setAllMembers(true); setDepartmentIds(new Set()); }}
              >
                全体成员
              </button>
              {departments.map(dept => {
                const active = !allMembers && departmentIds.has(dept.id);
                return (
                  <button
                    key={dept.id}
                    type="button"
                    className={`${styles.toggleChip} ${active ? styles.toggleChipActive : ""}`}
                    onClick={() => {
                      setAllMembers(false);
                      setDepartmentIds(current => {
                        const next = new Set(current);
                        if (next.has(dept.id)) next.delete(dept.id); else next.add(dept.id);
                        if (next.size === 0) setAllMembers(true);
                        return next;
                      });
                    }}
                  >
                    {dept.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {error && <p style={{ margin: "12px 0 0", color: "var(--danger)", fontSize: 11 }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", padding: "8px 14px", cursor: "pointer" }}>取消</button>
          <button type="submit" disabled={saving || !title.trim()} style={{ border: "1px solid var(--ink)", borderRadius: 8, background: "var(--ink)", color: "#fff", padding: "8px 14px", cursor: "pointer", opacity: saving || !title.trim() ? .5 : 1 }}>{saving ? "创建中…" : `创建${kind === "event" ? "事件" : "任务"}`}</button>
        </div>
      </form>
    </div>
  );
}

function BoundedTimePicker({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [hour = "00", minute = "00"] = value.split(":");

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={rootRef} className={styles.timeField}>
      <span style={{ display: "block", marginBottom: 5, fontSize: 11, color: "var(--muted)" }}>{label}</span>
      <button type="button" className={styles.timeButton} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span>{hour}:{minute}</span><span aria-hidden>⌄</span>
      </button>
      {open && (
        <div className={styles.timePopover} role="group" aria-label={`${label}选择`}>
          <div className={styles.timeList} aria-label="小时 0 到 23">
            {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map(option => (
              <button key={option} type="button" className={`${styles.timeOption} ${option === hour ? styles.timeOptionActive : ""}`} onClick={() => onChange(`${option}:${minute}`)}>{option} 时</button>
            ))}
          </div>
          <div className={styles.timeList} aria-label="分钟 00 到 59">
            {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map(option => (
              <button key={option} type="button" className={`${styles.timeOption} ${option === minute ? styles.timeOptionActive : ""}`} onClick={() => { onChange(`${hour}:${option}`); setOpen(false); }}>{option} 分</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type CalendarSelection =
  | { kind: "event"; value: ProductionEvent }
  | { kind: "task"; value: PlanningTask }
  | { kind: "milestone"; value: PlanningMilestone };

function CalendarDetailDrawer({ productionId, selection, onClose }: {
  productionId: string;
  selection: CalendarSelection;
  onClose: () => void;
}) {
  const isEvent = selection.kind === "event";
  const isTask = selection.kind === "task";
  const value = selection.value;
  const href = isEvent
    ? `/production/${productionId}/events/${value.id}`
    : isTask ? `/production/${productionId}/tasks/${value.id}` : null;
  const title = isEvent ? selection.value.title : isTask ? selection.value.title : selection.value.name;
  const start = isEvent ? selection.value.startTime : isTask ? selection.value.effectiveStartTime : selection.value.endDate;
  const end = isEvent ? selection.value.endTime : isTask ? selection.value.effectiveEndTime : null;
  const description = isEvent ? selection.value.description : isTask ? selection.value.description : "项目里程碑";

  return (
    <aside className={styles.detailDrawer} aria-label={`${title}详情`}>
      <div style={{ minHeight: 94, padding: "20px 22px", borderBottom: "1px solid var(--line)", display: "flex", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 9, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase" }}>
            {isEvent ? "Event" : isTask ? "Task" : "Milestone"}
          </p>
          <h2 style={{ margin: "6px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 22, fontWeight: 500, lineHeight: 1.3 }}>{title}</h2>
        </div>
        <button type="button" aria-label="关闭详情" onClick={onClose} style={{ width: 31, height: 31, border: "1px solid var(--line)", borderRadius: "50%", background: "transparent", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
      </div>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 15 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {isEvent && <Badge tone={selection.value.status === "completed" ? "green" : selection.value.status === "cancelled" ? "red" : "blue"}>{selection.value.status === "published" ? "已发布" : selection.value.status === "completed" ? "已完成" : selection.value.status === "cancelled" ? "已取消" : "草稿"}</Badge>}
          {isTask && <Badge tone={selection.value.status === "done" ? "green" : selection.value.status === "in_progress" ? "blue" : "neutral"}>{TASK_STATUS_LABELS[selection.value.status] ?? selection.value.status}</Badge>}
          {isTask && selection.value.departmentName && <Badge>{selection.value.departmentName}</Badge>}
        </div>
        {start && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
            <b style={{ color: "var(--ink)" }}>时间</b><br />
            {new Date(start).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: isEvent || isTask ? "2-digit" : undefined, minute: isEvent || isTask ? "2-digit" : undefined, hour12: false })}
            {end ? ` — ${new Date(end).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
          </p>
        )}
        {isEvent && selection.value.location && <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}><b style={{ color: "var(--ink)" }}>地点</b><br />{selection.value.location}</p>}
        {isTask && selection.value.eventTitle && <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}><b style={{ color: "var(--ink)" }}>关联事件</b><br />{selection.value.eventTitle}</p>}
        {description && <p style={{ margin: 0, paddingTop: 14, borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--ink)", lineHeight: 1.7 }}>{description}</p>}
        {href && (
          <Link href={href} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 4, border: "1px solid var(--ink)", borderRadius: 8, padding: "10px 14px", color: "#fff", background: "var(--ink)", textDecoration: "none", fontSize: 12, fontWeight: 700 }}>
            前往{isEvent ? "事件" : "任务"}详情 →
          </Link>
        )}
      </div>
    </aside>
  );
}

function CalendarView({ productionId, events, tasks, milestones, departments }: Props) {
  // 「今天」按 CST 算，不按浏览器本地——跨时区的人不该看到不同的当月/今日高亮
  const today = useMemo(() => {
    const [y, m, d] = todayCSTStr().split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }, []);
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());  // 0-based
  const [quickCreateDate, setQuickCreateDate] = useState<string | null>(null);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);

  // 绑定 event 的任务不单独上日历（随事件显示）；未绑定的按有效开始日期上格
  const standaloneTasks = useMemo(
    () => tasks.filter(t => !t.eventId && t.effectiveStartTime),
    [tasks],
  );

  const byDate = useMemo(() => {
    const map = new Map<string, { events: ProductionEvent[]; tasks: PlanningTask[]; milestones: PlanningMilestone[] }>();
    const entry = (date: string) => {
      if (!map.has(date)) map.set(date, { events: [], tasks: [], milestones: [] });
      return map.get(date)!;
    };
    for (const ev of events) {
      if (!ev.startTime || ev.status === "cancelled") continue;
      entry(isoCSTDateStr(ev.startTime)).events.push(ev);
    }
    for (const t of standaloneTasks) {
      entry(isoCSTDateStr(t.effectiveStartTime!)).tasks.push(t);
    }
    for (const m of milestones) {
      entry(m.endDate.slice(0, 10)).milestones.push(m);
    }
    return map;
  }, [events, standaloneTasks, milestones]);

  // 周一起始月网格（原型为 4 周静态；实装整月 6 周）
  const cells = useMemo(() => {
    // 全部用 Date.UTC 构造：格子代表「CST 的某一天」，用本地构造会让 UTC+10 之类的
    // 浏览器整体错一天（本地午夜换算成 CST 落到前一天）
    const first = new Date(Date.UTC(year, month, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(Date.UTC(year, month, 1 - lead + i)));
  }, [year, month]);

  const move = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth());
  };

  const todayStr = ymd(today);

  // 原型 CalendarMock：panel + panelHeading(kicker/h2/legend) + calendarWeek + calendarGrid + hint
  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {year} 年
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            项目日历
          </h2>
          <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            月历统一展示事件、任务与里程碑；点击事项在右侧查看，点击空白处新建。
          </small>
        </div>
        {/* 月导航 + legend（原型 legend 右上） */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => { setYear(today.getUTCFullYear()); setMonth(today.getUTCMonth()); }}
              style={{ ...CAL_NAV_BTN, width: "auto", padding: "0 10px", fontSize: 10, fontWeight: 700 }}
            >
              定位至今天
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button onClick={() => move(-1)} aria-label="上一月" style={CAL_NAV_BTN}>‹</button>
              <span aria-label={`当前月份 ${month + 1}月`} style={{ minWidth: 48, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line)", borderRadius: 6, background: "var(--surface)", color: "var(--ink)", fontSize: 10, fontWeight: 700 }}>{month + 1}月</span>
              <button onClick={() => move(1)} aria-label="下一月" style={CAL_NAV_BTN}>›</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, color: "var(--muted)", fontSize: 9 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--script)" }} />事件
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--stage)" }} />任务
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--ink)", transform: "rotate(45deg)" }} />里程碑
            </span>
          </div>
        </div>
      </div>

      {/* calendarWeek */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {["一", "二", "三", "四", "五", "六", "日"].map(d => (
          <span key={d} style={{ padding: 7, color: "var(--muted)", fontSize: 9, textAlign: "center" }}>周{d}</span>
        ))}
      </div>
      {/* calendarGrid（93px 格、1px 网格线、todayCell #f8f0e7） */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", borderTop: "1px solid var(--line)", borderLeft: "1px solid var(--line)" }}>
        {cells.map((d) => {
          const date = ymd(d);
          const inMonth = d.getUTCMonth() === month;
          const day = byDate.get(date);
          const isToday = date === todayStr;
          const dayEntries: CalendarSelection[] = day ? [
            ...day.milestones.map(value => ({ kind: "milestone" as const, value })),
            ...day.events.map(value => ({ kind: "event" as const, value })),
            ...day.tasks.map(value => ({ kind: "task" as const, value })),
          ] : [];
          const shownEntries = dayEntries.slice(0, 4);
          const hidden = Math.max(0, dayEntries.length - shownEntries.length);
          return (
            <div
              key={date}
              role="button"
              tabIndex={0}
              aria-label={`${date} 快捷新建事件或任务`}
              title="点击空白处快捷新建事件或任务"
              onClick={e => {
                if ((e.target as HTMLElement).closest("button,a")) return;
                setQuickCreateDate(date);
              }}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setQuickCreateDate(date); }}
              className={`${styles.calendarCell} ${isToday ? styles.calendarCellToday : ""}`}
              style={{ opacity: inMonth ? 1 : 0.45 }}
            >
              <b style={{ fontSize: 9, color: "var(--muted)" }}>{d.getUTCDate()}</b>
              {shownEntries.map(entry => {
                const entryTitle = entry.kind === "event" ? entry.value.title : entry.kind === "task" ? entry.value.title : entry.value.name;
                const prefix = entry.kind === "event" ? "事件 · " : entry.kind === "task" ? "任务 · " : "◆ ";
                const tone = entry.kind === "event"
                  ? { background: "var(--script-soft)", color: "var(--script)" }
                  : entry.kind === "task"
                    ? { background: "#f2e3d6", color: "var(--stage)" }
                    : { background: "var(--ink)", color: "#fff" };
                return (
                  <button key={`${entry.kind}-${entry.value.id}`} type="button" className={styles.calendarChip} title={entryTitle} onClick={e => { e.stopPropagation(); setSelection(entry); }} style={tone}>
                    {prefix}{entryTitle}
                  </button>
                );
              })}
              {hidden > 0 && (
                <span style={{ fontSize: 8, color: "var(--muted)" }}>+{hidden} 项</span>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 9, color: "var(--muted)" }}>
        点击任意日期空白处可快捷新建事件或任务；事件将自动生成并关联一条执行日程。绑定事件的任务随事件显示，不单独占格。
      </p>
      {quickCreateDate && (
        <QuickCreateModal
          productionId={productionId}
          date={quickCreateDate}
          departments={departments}
          events={events}
          onClose={() => setQuickCreateDate(null)}
        />
      )}
      {selection && (
        <>
          <button
            type="button"
            className={styles.drawerBackdrop}
            aria-label="关闭事项详情"
            onClick={() => setSelection(null)}
          />
          <CalendarDetailDrawer productionId={productionId} selection={selection} onClose={() => setSelection(null)} />
        </>
      )}
    </section>
  );
}

const CAL_NAV_BTN: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: "1px solid var(--line)",
  background: "var(--surface)", color: "var(--muted)", cursor: "pointer",
  fontSize: 13, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
};

// ─── 任务甘特（原型 milestone gantt 的任务版：粒度切换 + 拖拽改期）─────────────

type GanttScale = "day" | "month" | "quarter" | "year";
type GanttDragMode = "move" | "resize-start" | "resize-end";

const DAY_MS = 86_400_000;

/** 状态→条形配色（原型 milestoneBar* 色板；受阻优先于状态） */
function barTone(t: PlanningTask): { bg: string; color: string } {
  if (t.isBlocked && t.status !== "done") return { bg: "#f5dfd8", color: "#8a4434" };
  if (t.status === "done") return { bg: "#e8e6f7", color: "#535078" };
  if (t.status === "in_progress") return { bg: "var(--script)", color: "#fff" };
  return { bg: "#d2f0e8", color: "#28594f" };  // pending / awaiting
}

function floorToMonday(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

function TaskGanttView({ productionId, tasks, milestones }: Props) {
  const router = useRouter();
  const [scale, setScale] = useState<GanttScale>("month");
  const [localTasks, setLocalTasks] = useState<PlanningTask[]>(tasks);
  useEffect(() => { setLocalTasks(tasks); }, [tasks]);

  const timedTasks = useMemo(
    () => localTasks
      .filter(t => t.effectiveStartTime)
      .sort((a, b) => (a.effectiveStartTime! < b.effectiveStartTime! ? -1 : 1)),
    [localTasks],
  );

  // 轴锚点：最早内容与今天取早者，按粒度取整；跨度固定
  const { axisStart, axisDays, labels } = useMemo(() => {
    const today = new Date();
    const earliest = timedTasks[0]?.effectiveStartTime
      ? new Date(timedTasks[0].effectiveStartTime)
      : today;
    const base = earliest < today ? earliest : today;
    if (scale === "day") {
      const start = floorToMonday(base);
      return {
        axisStart: start, axisDays: 42,
        labels: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(start); d.setDate(d.getDate() + i * 7);
          return `${d.getMonth() + 1}/${d.getDate()}`;
        }),
      };
    }
    if (scale === "month") {
      const start = new Date(base.getFullYear(), base.getMonth(), 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 6, 1);
      return {
        axisStart: start, axisDays: Math.round((end.getTime() - start.getTime()) / DAY_MS),
        labels: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
          return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
        }),
      };
    }
    if (scale === "quarter") {
      const start = new Date(base.getFullYear(), Math.floor(base.getMonth() / 3) * 3, 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 18, 1);
      return {
        axisStart: start, axisDays: Math.round((end.getTime() - start.getTime()) / DAY_MS),
        labels: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(start.getFullYear(), start.getMonth() + i * 3, 1);
          return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
        }),
      };
    }
    const start = new Date(base.getFullYear(), 0, 1);
    return {
      axisStart: start, axisDays: 365,
      labels: Array.from({ length: 12 }, (_, i) => `${i + 1} 月`),
    };
  }, [scale, timedTasks]);

  const axisEndMs = axisStart.getTime() + axisDays * DAY_MS;
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - axisStart.getTime()) / (axisEndMs - axisStart.getTime()) * 100));

  const visibleMilestones = milestones.filter(m => {
    const ms = new Date(`${m.endDate.slice(0, 10)}T12:00:00`).getTime();
    return ms >= axisStart.getTime() && ms < axisEndMs;
  });

  // ── 拖拽改期（写回自身 start/end；继承时间被拖动即物化为自身时间）──────────
  const dragRef = useRef<{
    id: string; mode: GanttDragMode; startX: number; width: number;
    origStart: string; origEnd: string; moved: boolean;
    snapshot: PlanningTask[];
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [saving, setSaving] = useState<string | null>(null);

  function startDrag(e: React.PointerEvent<HTMLElement>, t: PlanningTask, mode: GanttDragMode) {
    const timeline = e.currentTarget.closest("[data-gantt-timeline]") as HTMLElement | null;
    if (!timeline) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    suppressClickRef.current = false;
    dragRef.current = {
      id: t.id, mode, startX: e.clientX, width: timeline.getBoundingClientRect().width,
      origStart: t.effectiveStartTime!, origEnd: t.effectiveEndTime ?? t.effectiveStartTime!,
      moved: false, snapshot: localTasks,
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) > 3) {
      drag.moved = true;
      suppressClickRef.current = true;
    }
    const deltaDays = Math.round((e.clientX - drag.startX) / drag.width * axisDays);
    setLocalTasks(cur => cur.map(t => {
      if (t.id !== drag.id) return t;
      let ns = drag.origStart, ne = drag.origEnd;
      if (drag.mode === "move") { ns = addDaysIso(drag.origStart, deltaDays); ne = addDaysIso(drag.origEnd, deltaDays); }
      else if (drag.mode === "resize-start") {
        ns = addDaysIso(drag.origStart, deltaDays);
        if (ns > ne) ns = ne;
      } else {
        ne = addDaysIso(drag.origEnd, deltaDays);
        if (ne < ns) ne = ns;
      }
      return { ...t, startTime: ns, endTime: ne, effectiveStartTime: ns, effectiveEndTime: ne };
    }));
  }

  async function finishDrag(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !drag.moved) return;
    // 按最终指针位置重算终值（与 moveDrag 同一公式，避免读异步 state）
    const deltaDays = Math.round((e.clientX - drag.startX) / drag.width * axisDays);
    let ns = drag.origStart, ne = drag.origEnd;
    if (drag.mode === "move") { ns = addDaysIso(drag.origStart, deltaDays); ne = addDaysIso(drag.origEnd, deltaDays); }
    else if (drag.mode === "resize-start") { ns = addDaysIso(drag.origStart, deltaDays); if (ns > ne) ns = ne; }
    else { ne = addDaysIso(drag.origEnd, deltaDays); if (ne < ns) ne = ns; }
    if (ns === drag.origStart && ne === drag.origEnd) return;
    setSaving(drag.id);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${drag.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime: ns, endTime: ne }),
      });
      if (!res.ok) {
        setLocalTasks(drag.snapshot);
        const data = await res.json().catch(() => null);
        alert(data?.error ?? "改期失败（可能无编辑权限）");
      }
    } catch {
      setLocalTasks(drag.snapshot);
      alert("网络错误，改期未保存");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {labels[0]} — {labels[labels.length - 1]}
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            任务甘特图
          </h2>
          <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            时间为有效起止（自身 → 绑定日程 → 事件）；拖动条形改期，拖动即固化为任务自身时间。
          </small>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexShrink: 0, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 2, border: "1px solid var(--line)", borderRadius: 8, padding: 2 }} aria-label="时间轴粒度">
            {([["day", "日"], ["month", "月"], ["quarter", "季"], ["year", "年"]] as const).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={scale === value}
                onClick={() => setScale(value)}
                style={{
                  border: 0, borderRadius: 6, padding: "3px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                  background: scale === value ? "var(--ink)" : "transparent",
                  color: scale === value ? "#fff" : "var(--muted)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, color: "var(--muted)", fontSize: 9 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--script)" }} />进行中</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "#d2f0e8", border: "1px solid #9ccfc0" }} />待处理</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "#f5dfd8", border: "1px solid #d8a893" }} />受阻</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 7, height: 7, borderRadius: 2, background: "#e8e6f7", border: "1px solid #b9b5dd" }} />完成</span>
          </div>
        </div>
      </div>

      {timedTasks.length === 0 ? (
        <p style={{ margin: 0, padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
          暂无带时间的任务。在任务上设置起止时间，或绑定带时间的日程/事件后此处生成时间条。
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 640 }}>
            {/* 轴表头 + 里程碑标记条 */}
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr" }}>
              <span />
              <div style={{ position: "relative", display: "grid", gridTemplateColumns: `repeat(${labels.length}, 1fr)`, minHeight: 34 }}>
                {labels.map(l => (
                  <b key={l} style={{ fontSize: 9, fontWeight: 400, color: "var(--muted)", textAlign: "left", paddingTop: 4, borderLeft: "1px solid var(--line)", paddingLeft: 5 }}>{l}</b>
                ))}
                {visibleMilestones.map(m => {
                  const left = pct(new Date(`${m.endDate.slice(0, 10)}T12:00:00`).getTime());
                  return (
                    <strong
                      key={m.id}
                      title={`${m.name} · ${m.endDate.slice(0, 10)}`}
                      style={{ position: "absolute", left: `${left}%`, bottom: 0, transform: "translateX(-50%)", fontSize: 10, color: "var(--ink)", cursor: "default" }}
                    >
                      ◆
                    </strong>
                  );
                })}
              </div>
            </div>
            {/* 任务行 */}
            {timedTasks.map(t => {
              const startMs = new Date(t.effectiveStartTime!).getTime();
              const endMs = Math.max(startMs + DAY_MS * 0.5, new Date(t.effectiveEndTime ?? t.effectiveStartTime!).getTime());
              const left = pct(startMs);
              const width = Math.max(pct(endMs) - left, 1.5);
              const tone = barTone(t);
              const dur = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
              const context = t.eventTitle ?? t.departmentName;
              return (
                <div key={t.id} style={{ display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 48, borderTop: "1px solid var(--line)" }}>
                  <button
                    onClick={() => router.push(`/production/${productionId}/tasks/${t.id}`)}
                    style={{ border: 0, background: "transparent", padding: "6px 10px 6px 0", textAlign: "left", cursor: "pointer", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}
                  >
                    <b style={{ fontSize: 11, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.isBlocked && t.status !== "done" && <span title="被前置任务阻塞" style={{ color: "#8a4434" }}>⛔ </span>}
                      {t.title || "（未命名任务）"}
                    </b>
                    <small style={{ fontSize: 9, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[context, TASK_STATUS_LABELS[t.status] ?? t.status].filter(Boolean).join(" · ")}
                    </small>
                  </button>
                  <div
                    data-gantt-timeline
                    style={{
                      position: "relative", minHeight: 48,
                      backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px)",
                      backgroundSize: `${100 / labels.length}% 100%`,
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      title={`${t.title} · ${dur} 天${t.startTime ? "" : "（时间继承自绑定日程/事件，拖动后固化）"}`}
                      onClick={() => { if (!suppressClickRef.current) router.push(`/production/${productionId}/tasks/${t.id}`); }}
                      onPointerDown={e => startDrag(e, t, "move")}
                      onPointerMove={moveDrag}
                      onPointerUp={finishDrag}
                      style={{
                        position: "absolute", top: 13, height: 22, left: `${left}%`, width: `${width}%`,
                        borderRadius: 6, background: tone.bg, color: tone.color,
                        border: t.startTime ? "none" : "1px dashed rgba(24,42,42,.35)",
                        display: "flex", alignItems: "center", gap: 6, padding: "0 7px",
                        fontSize: 8, cursor: "grab", overflow: "hidden", whiteSpace: "nowrap",
                        boxShadow: "0 2px 6px rgba(24,42,42,.10)",
                        opacity: saving === t.id ? 0.6 : 1,
                        touchAction: "none",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
                      <em style={{ marginLeft: "auto", fontStyle: "normal", fontSize: 7 }}>{dur}天</em>
                      {/* 缩放把手 */}
                      <i
                        onPointerDown={e => startDrag(e, t, "resize-start")}
                        onPointerMove={moveDrag}
                        onPointerUp={finishDrag}
                        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }}
                      />
                      <i
                        onPointerDown={e => startDrag(e, t, "resize-end")}
                        onPointerMove={moveDrag}
                        onPointerUp={finishDrag}
                        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ─── 执行日程（原型 TimetableMock：部门泳道 × 15 分钟格 rundown）──────────────

// 原型 rundown_* 类型配色（call 橙/run 青/task 草绿/break 斜纹/notes 紫；默认=run 青）
const ITEM_TONE: Record<string, { bg: string; border: string }> = {
  call:   { bg: "#f2e3d6", border: "#d9ab8d" },
  run:    { bg: "#dce9e9", border: "rgba(47,102,112,.28)" },
  task:   { bg: "#edf0e5", border: "#c9d0b7" },
  break:  { bg: "repeating-linear-gradient(135deg, #f1f0eb 0, #f1f0eb 8px, #e6e4dc 8px, #e6e4dc 16px)", border: "#d4d1c7" },
  notes:  { bg: "#eee5f0", border: "#cdb9d3" },
  custom: { bg: "#dce9e9", border: "rgba(47,102,112,.28)" },
};

/** ISO → 当天 CST 的分钟数（时间轴定位用） */
function minutesOfIso(iso: string): number {
  const [h, m] = fmtTime(iso).split(":").map(Number);
  return h * 60 + m;
}

function fmtMin(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 版面的一列。服务端由两张表拼出来：
 *   event_rundown_column  → id / 顺序 / visible / frozen(is_pinned) / matchLocation
 *   event_group           → name / 成员（部门 + 人）
 *
 * 没有 roleNames：role 是项目可配置表、会改名，落库会漂。角色 chip 保留在编辑器里，
 * 但语义是「按角色批量勾选人员」，落库的是具体的人。
 */
type RundownColumn = {
  /** 服务端 event_rundown_column.id；本地新建尚未保存时是 `new-*` */
  id: string;
  /** people 列绑定的用户组 id；location 列为 null */
  groupId: string | null;
  name: string;
  kind: "people" | "location";
  departmentIds: string[];
  userIds: string[];
  /** location 列的匹配值（对应 event_schedule_item.location） */
  location: string;
  visible: boolean;
  /** 横向滚动时钉在左侧 → 服务端 is_pinned。与用户组的冻结快照无关。 */
  frozen: boolean;
};

type ServerUserGroup = {
  id: string;
  name: string;
  members: { kind: "dept" | "user"; id: string }[];
};
type ServerRundownColumn = {
  id: string; groupId: string | null; matchLocation: string | null;
  orderIndex: number; isVisible: boolean; isPinned: boolean;
};
type ServerRundownPlacement = {
  entryType: "item" | "task"; entryId: string; color: string | null; pinnedColumnIds: string[];
};

type RundownEntrySelection =
  | { kind: "item"; id: string }
  | { kind: "task"; id: string };

type RundownDragEntry = RundownEntrySelection & { duration: number };

const RUNDOWN_COLORS = ["#dce9e9", "#edf0e5", "#f2e3d6", "#eee5f0", "#e8e6f7", "#f5dfd8"];

/** 保留 ISO 的 CST 日期，换成给定的 CST "HH:mm" → UTC ISO */
function withTime(iso: string, value: string): string {
  return dateTimeToIso(isoCSTDateStr(iso), value);
}

function RundownColumnEditor({ column, departments, members, roles, onChange, onRename, onToggleValue, onToggleRole, onDelete, onClose }: {
  column: RundownColumn;
  departments: PlanningDept[];
  members: PlanningMember[];
  roles: string[];
  /** 只改展示属性（显隐 / 粘性）——不落用户组 */
  onChange: (patch: Partial<RundownColumn>) => void;
  /** 改名 = 改用户组，失焦时才发，不然每敲一个字打一次请求 */
  onRename: (name: string) => void;
  onToggleValue: (key: "departmentIds" | "userIds", value: string) => void;
  onToggleRole: (role: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState(column.name);
  useEffect(() => { setDraftName(column.name); }, [column.id, column.name]);
  return (
    <div className={styles.columnEditor} role="dialog" aria-label={`编辑人员组 ${column.name}`} onClick={event => event.stopPropagation()}>
      <div className={styles.inlineEditorHeader}>
        <b>编辑人员组</b>
        <button type="button" onClick={onClose} aria-label="关闭人员组编辑">×</button>
      </div>
      <label className={styles.inlineField}>人员组名称
        <input
          value={draftName}
          onChange={event => setDraftName(event.target.value)}
          onBlur={() => { if (draftName.trim() && draftName !== column.name) onRename(draftName.trim()); }}
        />
      </label>
      <button type="button" className={styles.menuAction} onClick={() => onChange({ frozen: !column.frozen })}>
        <span>{column.frozen ? "▣" : "▢"}</span>
        <span><b>{column.frozen ? "取消冻结此列" : "冻结此列"}</b><small>横向滚动时保持在左侧</small></span>
      </button>
      <div className={styles.optionSection}><b>部门</b><div className={styles.multiPicker}>{departments.map(dept => <button key={dept.id} type="button" className={`${styles.toggleChip} ${column.departmentIds.includes(dept.id) ? styles.toggleChipActive : ""}`} onClick={() => onToggleValue("departmentIds", dept.id)}>{dept.name}</button>)}</div></div>
      {/* 角色是「按角色批量勾人」的快捷方式，不落库——role 是项目可配置表，会改名。
          chip 的高亮由「该角色的人是否都已在名单里」推导。 */}
      <div className={styles.optionSection}><b>按角色批量选人</b><div className={styles.multiPicker}>{roles.map(role => {
        const roleUserIds = members.filter(m => m.roles.includes(role)).map(m => m.userId);
        const allIn = roleUserIds.length > 0 && roleUserIds.every(uid => column.userIds.includes(uid));
        return <button key={role} type="button" className={`${styles.toggleChip} ${allIn ? styles.toggleChipActive : ""}`} onClick={() => onToggleRole(role)}>{role}</button>;
      })}</div></div>
      <div className={styles.optionSection}><b>个人</b><div className={styles.multiPicker}>{members.map(member => <button key={member.userId} type="button" className={`${styles.toggleChip} ${column.userIds.includes(member.userId) ? styles.toggleChipActive : ""}`} onClick={() => onToggleValue("userIds", member.userId)}>{member.name}</button>)}</div></div>
      <button type="button" className={styles.deleteAction} onClick={onDelete}>删除此人员组</button>
    </div>
  );
}

function RundownEntryEditor({ selection, item, task, lanes, laneIds, color, onSave, onClose }: {
  selection: RundownEntrySelection;
  item: EventScheduleItemWithParticipants | null;
  task: EventTechReq | null;
  lanes: RundownColumn[];
  laneIds: string[];
  color: string;
  onSave: (draft: { title: string; description: string; start: string; end: string; location: string; itemType: string; status: string; laneIds: string[]; color: string }) => Promise<void>;
  onClose: () => void;
}) {
  const source = item ?? task;
  const startIso = item?.startTime ?? task?.effectiveStartTime ?? "";
  const endIso = item?.endTime ?? task?.effectiveEndTime ?? "";
  const [title, setTitle] = useState(source?.title ?? "");
  const [description, setDescription] = useState(item?.notes ?? task?.description ?? "");
  const [start, setStart] = useState(startIso ? hhmm(startIso) : "09:00");
  const [end, setEnd] = useState(endIso ? hhmm(endIso) : "10:00");
  const [location, setLocation] = useState(item?.location ?? "");
  const [itemType, setItemType] = useState(item?.itemType ?? "task");
  const [status, setStatus] = useState(task?.status ?? "pending");
  const [selectedLaneIds, setSelectedLaneIds] = useState<string[]>(laneIds);
  const [selectedColor, setSelectedColor] = useState(color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!source || !startIso || !endIso || !title.trim()) return;
    const nextStart = withTime(startIso, start);
    const nextEnd = withTime(endIso, end);
    if (new Date(nextEnd) <= new Date(nextStart)) { setError("结束时间需晚于开始时间"); return; }
    setSaving(true); setError(null);
    try {
      await onSave({ title: title.trim(), description, start: nextStart, end: nextEnd, location, itemType, status, laneIds: selectedLaneIds, color: selectedColor });
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return (
    <aside className={styles.entryEditor} aria-label={`${selection.kind === "item" ? "日程" : "任务"}块编辑`}>
      <div className={styles.inlineEditorHeader}><div><small>{selection.kind === "item" ? "SCHEDULE" : "TASK"}</small><b>编辑事项块</b></div><button type="button" onClick={onClose} aria-label="关闭事项编辑">×</button></div>
      <label className={styles.inlineField}>标题<input value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className={styles.inlineField}>说明<textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className={styles.twoFields}><BoundedTimePicker label="开始" value={start} onChange={setStart} /><BoundedTimePicker label="结束" value={end} onChange={setEnd} /></div>
      {item ? <>
        <label className={styles.inlineField}>类型<select value={itemType} onChange={event => setItemType(event.target.value)}><option value="run">执行</option><option value="call">集合</option><option value="task">任务</option><option value="break">休息</option><option value="notes">备注</option><option value="custom">自定义</option></select></label>
        <label className={styles.inlineField}>地点<input value={location} onChange={event => setLocation(event.target.value)} /></label>
      </> : <label className={styles.inlineField}>状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="awaiting">待确认</option><option value="pending">待处理</option><option value="in_progress">进行中</option><option value="done">完成</option></select></label>}
      <div className={styles.optionSection}><b>显示在人员组（可多选）</b><div className={styles.multiPicker}>{lanes.map(lane => <button key={lane.id} type="button" className={`${styles.toggleChip} ${selectedLaneIds.includes(lane.id) ? styles.toggleChipActive : ""}`} onClick={() => setSelectedLaneIds(current => current.includes(lane.id) ? current.filter(id => id !== lane.id) : [...current, lane.id])}>{lane.name}</button>)}</div></div>
      <div className={styles.optionSection}><b>事项颜色</b><div className={styles.colorPicker}>{RUNDOWN_COLORS.map(option => <button key={option} type="button" aria-label={`颜色 ${option}`} aria-pressed={selectedColor === option} onClick={() => setSelectedColor(option)} style={{ background: option }} />)}</div></div>
      {error && <p className={styles.editorError}>{error}</p>}
      <button type="button" className={styles.primaryEditorAction} disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存事项"}</button>
    </aside>
  );
}

function TimetableView({ productionId, events, departments, members }: Props) {
  const timedEvents = useMemo(
    () => events.filter(e => e.startTime).sort((a, b) => (a.startTime! < b.startTime! ? -1 : 1)),
    [events],
  );
  const [eventId, setEventId] = useState<string>(timedEvents[0]?.id ?? "");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [items, setItems] = useState<EventScheduleItemWithParticipants[]>([]);
  const [eventTasks, setEventTasks] = useState<EventTechReq[]>([]);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<"all" | "custom">("all");
  const [columns, setColumns] = useState<RundownColumn[]>([]);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<RundownEntrySelection | null>(null);
  const [entryColors, setEntryColors] = useState<Record<string, string>>({});
  const [entryLaneOverrides, setEntryLaneOverrides] = useState<Record<string, string[]>>({});
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const dragColumnId = useRef<string | null>(null);
  const dragEntryRef = useRef<RundownDragEntry | null>(null);
  const resizeRef = useRef<{ selection: RundownEntrySelection; edge: "start" | "end"; startY: number; startIso: string; endIso: string; nextStart: string; nextEnd: string } | null>(null);

  // 版面来自服务端，不再是每人一份的 localStorage——rundown 是 organizer 定好
  // 大家遵守的东西。列 = event_rundown_column ⋈ event_group。
  useEffect(() => {
    if (!eventId) { setColumns([]); return; }
    let cancelled = false;
    Promise.all([
      fetch(`${BASE_PATH}/api/production/${productionId}/user-groups?eventId=${eventId}`).then(r => r.json()).catch(() => ({})),
      fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/rundown`).then(r => r.json()).catch(() => ({})),
    ]).then(([groupRes, layoutRes]) => {
      if (cancelled) return;
      const groups = new Map<string, ServerUserGroup>(
        ((groupRes.groups ?? []) as ServerUserGroup[]).map(g => [g.id, g]),
      );
      setColumns(((layoutRes.columns ?? []) as ServerRundownColumn[]).map(col => {
        const group = col.groupId ? groups.get(col.groupId) : undefined;
        return {
          id: col.id,
          groupId: col.groupId,
          name: group?.name ?? col.matchLocation ?? "未命名",
          kind: col.groupId ? "people" as const : "location" as const,
          departmentIds: (group?.members ?? []).filter(m => m.kind === "dept").map(m => m.id),
          userIds: (group?.members ?? []).filter(m => m.kind === "user").map(m => m.id),
          location: col.matchLocation ?? "",
          visible: col.isVisible,
          frozen: col.isPinned,
        };
      }));
      const colors: Record<string, string> = {};
      const lanes: Record<string, string[]> = {};
      for (const p of (layoutRes.placements ?? []) as ServerRundownPlacement[]) {
        const key = `${p.entryType}:${p.entryId}`;
        if (p.color) colors[key] = p.color;
        if (p.pinnedColumnIds.length) lanes[key] = p.pinnedColumnIds;
      }
      setEntryColors(colors);
      setEntryLaneOverrides(lanes);
    });
    return () => { cancelled = true; };
  }, [productionId, eventId]);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule`).then(r => r.json()),
      fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/tech-reqs`).then(r => r.json()).catch(() => ({})),
    ])
      .then(([sched, reqs]: [{ items?: EventScheduleItemWithParticipants[] }, { techReqs?: EventTechReq[] }]) => {
        if (cancelled) return;
        setItems((sched.items ?? []).filter(it => it.startTime && it.endTime));
        // 绑定 event 但未绑 schedule item 的任务上执行表；绑了 schedule 的随条目显示不重复画
        setEventTasks((reqs.techReqs ?? []).filter(t =>
          t.scheduleItemIds.length === 0 && t.effectiveStartTime && t.effectiveEndTime
        ));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [productionId, eventId]);

  const event = timedEvents.find(e => e.id === eventId) ?? null;

  const lanes = useMemo<RundownColumn[]>(() => {
    if (viewMode === "custom") {
      const active = columns.filter(column => column.visible);
      return active.length ? active : [{ id: "__empty", groupId: null, name: "未选择列", kind: "people", departmentIds: [], userIds: [], location: "", visible: true, frozen: false }];
    }
    const all = departments.map(dept => ({ id: `all-${dept.id}`, groupId: null, name: dept.name, kind: "people" as const, departmentIds: [dept.id], userIds: [], location: "", visible: true, frozen: false }));
    return all.length ? all : [{ id: "__all", groupId: null, name: "全体成员", kind: "people", departmentIds: [], userIds: [], location: "", visible: true, frozen: false }];
  }, [columns, departments, viewMode]);

  // 人员选项：schedule 参与人 + 任务 assignee 聚合
  const people = useMemo(() => members.map(member => [member.userId, member.name] as [string, string]), [members]);
  const memberById = useMemo(() => new Map(members.map(member => [member.userId, member])), [members]);
  const roleOptions = useMemo(() => [...new Set(members.flatMap(member => member.roles))].sort((a, b) => a.localeCompare(b, "zh-CN")), [members]);

  const visibleItems = personFilter === "all"
    ? items
    : items.filter(it => it.participants.some(p => p.userId === personFilter) || it.itemType === "break");
  const visibleTasks = personFilter === "all"
    ? eventTasks
    : eventTasks.filter(t => t.assignees.some(a => a.userId === personFilter));

  // 时间轴：15 分钟粒度（schedule 与任务共同决定范围）
  const SLOT = 15;
  const allStarts = [
    ...items.map(it => minutesOfIso(it.startTime!)),
    ...eventTasks.map(t => minutesOfIso(t.effectiveStartTime!)),
  ];
  const allEnds = [
    ...items.map(it => minutesOfIso(it.endTime!)),
    ...eventTasks.map(t => minutesOfIso(t.effectiveEndTime!)),
  ];
  const startMin = allStarts.length ? Math.floor(Math.min(...allStarts) / SLOT) * SLOT : 0;
  const endMin = allEnds.length ? Math.ceil(Math.max(...allEnds) / SLOT) * SLOT : 0;
  const slots = Array.from({ length: Math.max(0, (endMin - startMin) / SLOT) }, (_, i) => startMin + i * SLOT);
  /**
   * 地点带从**事项自己的 location** 推导，不再是独立实体。
   *
   * 地点是 event_schedule_item.location（早就有），一列的人 9 点在主剧场、14 点在
   * A3——在列上另存一份地点答不出这个，还会跟事项那份打架。这里显示的是「这一列
   * 当前的事项都在哪儿」，改地点去改事项，单一真相。
   */
  const laneLocations = useMemo(() => lanes.map(lane => {
    const locs = new Set(
      items.filter(it => it.location.trim() && itemMatchesColumn(it, lane)).map(it => it.location.trim()),
    );
    return [...locs];
  }), [lanes, items]);   // eslint-disable-line react-hooks/exhaustive-deps

  const hasLocationRow = laneLocations.some(l => l.length > 0);
  const headerRow = hasLocationRow ? 2 : 1;
  const bodyRowStart = headerRow + 1;

  const locationSegments = useMemo(() => {
    if (!hasLocationRow) return [] as { key: string; label: string; start: number; span: number }[];
    const result: { key: string; label: string; start: number; span: number }[] = [];
    laneLocations.forEach((locs, index) => {
      const label = locs.join(" / ");
      const previous = result[result.length - 1];
      if (previous && previous.label === label) previous.span += 1;
      else result.push({ key: `loc-${index}`, label, start: index + 2, span: 1 });
    });
    return result;
  }, [hasLocationRow, laneLocations]);

  function itemMatchesColumn(item: EventScheduleItemWithParticipants, column: RundownColumn): boolean {
    if (column.kind === "location") return !!column.location && item.location.trim() === column.location.trim();
    if (viewMode === "all" && item.departmentIds.length === 0 && item.participants.length === 0) return true;
    const hasRule = column.departmentIds.length + column.userIds.length > 0;
    if (!hasRule) return true;
    if (item.departmentIds.some(id => column.departmentIds.includes(id))) return true;
    return item.participants.some(participant => {
      const member = memberById.get(participant.userId);
      return column.userIds.includes(participant.userId)
        || !!member?.departmentIds.some(id => column.departmentIds.includes(id));
    });
  }

  function taskMatchesColumn(task: EventTechReq, column: RundownColumn): boolean {
    if (column.kind === "location") return !!column.location && event?.location.trim() === column.location.trim();
    if (viewMode === "all" && !task.departmentId && task.assignees.length === 0) return true;
    const hasRule = column.departmentIds.length + column.userIds.length > 0;
    if (!hasRule) return true;
    if (task.departmentId && column.departmentIds.includes(task.departmentId)) return true;
    return task.assignees.some(assignee => {
      const member = memberById.get(assignee.userId);
      return column.userIds.includes(assignee.userId)
        || !!member?.departmentIds.some(id => column.departmentIds.includes(id));
    });
  }

  function placements(indexes: number[]): { start: number; span: number }[] {
    if (!indexes.length) return [];
    const idx = [...indexes].sort((a, b) => a - b);
    if (!idx.length) return [{ start: 2, span: lanes.length }];
    const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    return contiguous
      ? [{ start: idx[0] + 2, span: idx[idx.length - 1] - idx[0] + 1 }]
      : idx.map(i => ({ start: i + 2, span: 1 }));
  }

  function rowOf(startIso: string, endIso: string): { rowStart: number; rowSpan: number } {
    const rowStart = Math.max(bodyRowStart, Math.floor((minutesOfIso(startIso) - startMin) / SLOT) + bodyRowStart);
    const rowSpan = Math.max(1, Math.ceil((minutesOfIso(endIso) - minutesOfIso(startIso)) / SLOT));
    return { rowStart, rowSpan };
  }

  /** 版面落库：顺序 / 显隐 / 粘性 / 地点列。列身份由服务端按 group|地点 认。 */
  const saveLayout = useCallback(async (next: RundownColumn[]) => {
    if (!eventId) return;
    setLayoutError(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/rundown`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        columns: next.map(c => c.kind === "location"
          ? { matchLocation: c.location, isVisible: c.visible, isPinned: c.frozen }
          : { groupId: c.groupId, isVisible: c.visible, isPinned: c.frozen }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setLayoutError(data.error ?? "版面保存失败"); return; }
    // 用服务端回来的 id 回填——新建的列在本地是 `new-*`，条目钉列要引用真实 id
    setColumns(current => current.map((c, i) => {
      const server = (data.columns ?? [])[i] as ServerRundownColumn | undefined;
      return server ? { ...c, id: server.id } : c;
    }));
  }, [productionId, eventId]);

  /** 条目表现落库：颜色 + 钉列。 */
  const savePlacements = useCallback(async (
    colors: Record<string, string>, lanes: Record<string, string[]>,
  ) => {
    if (!eventId) return;
    const keys = [...new Set([...Object.keys(colors), ...Object.keys(lanes)])];
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/rundown`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        placements: keys.map(key => {
          const [entryType, ...rest] = key.split(":");
          return {
            entryType, entryId: rest.join(":"),
            color: colors[key] ?? null,
            // 服务端只认本 event 版面里的列 id，本地未保存的 `new-*` 先滤掉
            pinnedColumnIds: (lanes[key] ?? []).filter(id => !id.startsWith("new-") && !id.startsWith("all-") && !id.startsWith("__")),
          };
        }),
      }),
    });
    if (!res.ok) setLayoutError((await res.json().catch(() => ({}))).error ?? "事项表现保存失败");
  }, [productionId, eventId]);

  /** 改列的展示属性（显隐 / 粘性）——只动版面，不动用户组。 */
  function updateColumn(id: string, patch: Partial<RundownColumn>) {
    setColumns(current => {
      const next = current.map(column => column.id === id ? { ...column, ...patch } : column);
      void saveLayout(next);
      return next;
    });
  }

  /**
   * 改列的名称 / 成员——那是**用户组**的属性，落到 /user-groups。
   * 组是跨 event 共享的实体，所以这里改名会影响所有引用它的 rundown，这是有意的。
   */
  async function saveColumnGroup(column: RundownColumn, patch: { name?: string; departmentIds?: string[]; userIds?: string[] }) {
    const name = patch.name ?? column.name;
    const departmentIds = patch.departmentIds ?? column.departmentIds;
    const userIds = patch.userIds ?? column.userIds;
    const members = [
      ...departmentIds.map(id => ({ kind: "dept" as const, id })),
      ...userIds.map(id => ({ kind: "user" as const, id })),
    ];
    setLayoutError(null);

    if (!column.groupId) {
      // 新列：先建 A 型组（绑本 event），再把它排进版面
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/user-groups`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, name, members, poc: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setLayoutError(data.error ?? "用户组创建失败"); return; }
      const next = columns.map(c => c.id === column.id
        ? { ...c, groupId: data.group.id as string, name, departmentIds, userIds } : c);
      setColumns(next);
      await saveLayout(next);
      return;
    }

    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/user-groups/${column.groupId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, members }),
    });
    if (!res.ok) { setLayoutError((await res.json().catch(() => ({}))).error ?? "用户组保存失败"); return; }
    setColumns(current => current.map(c => c.id === column.id ? { ...c, name, departmentIds, userIds } : c));
  }

  function toggleColumnValue(id: string, key: "departmentIds" | "userIds", value: string) {
    const column = columns.find(c => c.id === id);
    if (!column) return;
    const values = column[key];
    void saveColumnGroup(column, {
      [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value],
    });
  }

  /** 角色 chip：按角色批量勾/取消人员。role 不落库（可配置表会改名），落的是人。 */
  function toggleColumnRole(id: string, role: string) {
    const column = columns.find(c => c.id === id);
    if (!column) return;
    const roleUserIds = members.filter(m => m.roles.includes(role)).map(m => m.userId);
    const allIn = roleUserIds.length > 0 && roleUserIds.every(uid => column.userIds.includes(uid));
    void saveColumnGroup(column, {
      userIds: allIn
        ? column.userIds.filter(uid => !roleUserIds.includes(uid))
        : [...new Set([...column.userIds, ...roleUserIds])],
    });
  }

  function addColumn(kind: RundownColumn["kind"] = "people", insertAt = columns.length) {
    const suffix = columns.filter(column => column.kind === kind).length + 1;
    const nextColumn: RundownColumn = {
      id: `new-${Date.now()}-${suffix}`,
      groupId: null,
      name: kind === "people" ? `人员组 ${suffix}` : `地点 ${suffix}`,
      kind,
      departmentIds: [], userIds: [], location: "", visible: true, frozen: false,
    };
    const next = [...columns];
    next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, nextColumn);
    setColumns(next);
    setViewMode("custom");
    setEditingColumnId(nextColumn.id);
    // people 列要等用户填了名称/成员才建组；location 列可以直接落库
    if (kind === "location") void saveLayout(next);
  }

  function removeColumn(id: string) {
    const next = columns.filter(c => c.id !== id);
    setColumns(next);
    setEditingColumnId(null);
    void saveLayout(next);
  }

  function dropColumn(targetId: string) {
    const sourceId = dragColumnId.current;
    dragColumnId.current = null;
    if (!sourceId || sourceId === targetId) return;
    setColumns(current => {
      const next = [...current];
      const from = next.findIndex(column => column.id === sourceId);
      const to = next.findIndex(column => column.id === targetId);
      if (from < 0 || to < 0) return current;
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void saveLayout(next);
      return next;
    });
  }

  function entryKey(selection: RundownEntrySelection): string {
    return `${selection.kind}:${selection.id}`;
  }

  function laneIndexes(selection: RundownEntrySelection, fallback: number[]): number[] {
    const override = entryLaneOverrides[entryKey(selection)];
    if (!override?.length) return fallback;
    return override.map(id => lanes.findIndex(lane => lane.id === id)).filter(index => index >= 0);
  }

  function isoAtMinutes(iso: string, minuteOfDay: number): string {
    const next = new Date(iso);
    next.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
    return next.toISOString();
  }

  async function dropEntryAt(lane: RundownColumn, minuteOfDay: number) {
    const dragging = dragEntryRef.current;
    dragEntryRef.current = null;
    if (!dragging) return;
    const key = entryKey(dragging);
    const nextLanes = { ...entryLaneOverrides, [key]: [lane.id] };
    setEntryLaneOverrides(nextLanes);
    void savePlacements(entryColors, nextLanes);
    if (dragging.kind === "item") {
      const item = items.find(entry => entry.id === dragging.id);
      if (!item?.startTime || !item.endTime) return;
      const startTime = isoAtMinutes(item.startTime, minuteOfDay);
      const endTime = new Date(new Date(startTime).getTime() + dragging.duration * 60_000).toISOString();
      await saveItemTime(item, startTime, endTime);
    } else {
      const task = eventTasks.find(entry => entry.id === dragging.id);
      if (!task?.effectiveStartTime || !task.effectiveEndTime) return;
      const startTime = isoAtMinutes(task.effectiveStartTime, minuteOfDay);
      const endTime = new Date(new Date(startTime).getTime() + dragging.duration * 60_000).toISOString();
      await saveTaskTime(task, startTime, endTime, lane.departmentIds[0] ?? task.departmentId);
    }
  }

  function beginResize(event: React.PointerEvent<HTMLElement>, selection: RundownEntrySelection, edge: "start" | "end", startIso: string, endIso: string) {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { selection, edge, startY: event.clientY, startIso, endIso, nextStart: startIso, nextEnd: endIso };
  }

  function moveResize(event: React.PointerEvent<HTMLElement>) {
    const state = resizeRef.current;
    if (!state) return;
    const delta = Math.round((event.clientY - state.startY) / 38) * SLOT;
    const startMs = new Date(state.startIso).getTime();
    const endMs = new Date(state.endIso).getTime();
    const nextStartMs = state.edge === "start" ? Math.min(startMs + delta * 60_000, endMs - SLOT * 60_000) : startMs;
    const nextEndMs = state.edge === "end" ? Math.max(endMs + delta * 60_000, startMs + SLOT * 60_000) : endMs;
    state.nextStart = new Date(nextStartMs).toISOString();
    state.nextEnd = new Date(nextEndMs).toISOString();
    if (state.selection.kind === "item") setItems(current => current.map(item => item.id === state.selection.id ? { ...item, startTime: state.nextStart, endTime: state.nextEnd } : item));
    else setEventTasks(current => current.map(task => task.id === state.selection.id ? { ...task, startTime: state.nextStart, endTime: state.nextEnd, effectiveStartTime: state.nextStart, effectiveEndTime: state.nextEnd } : task));
  }

  async function finishResize(event: React.PointerEvent<HTMLElement>) {
    const state = resizeRef.current;
    if (!state) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.selection.kind === "item") {
      const item = items.find(entry => entry.id === state.selection.id);
      if (item) await saveItemTime(item, state.nextStart, state.nextEnd);
    } else {
      const task = eventTasks.find(entry => entry.id === state.selection.id);
      if (task) await saveTaskTime(task, state.nextStart, state.nextEnd);
    }
  }

  async function saveItemTime(item: EventScheduleItemWithParticipants, startTime: string, endTime: string) {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule/${item.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startTime, endTime }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "日程时间保存失败");
    setItems(current => current.map(entry => entry.id === item.id ? { ...entry, startTime, endTime } : entry));
  }

  async function saveTaskTime(task: EventTechReq, startTime: string, endTime: string, departmentId = task.departmentId) {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${task.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startTime, endTime, departmentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "任务时间保存失败");
    setEventTasks(current => current.map(entry => entry.id === task.id ? { ...entry, departmentId, startTime, endTime, effectiveStartTime: startTime, effectiveEndTime: endTime } : entry));
  }

  async function saveSelectedEntry(selection: RundownEntrySelection, draft: { title: string; description: string; start: string; end: string; location: string; itemType: string; status: string; laneIds: string[]; color: string }) {
    const key = entryKey(selection);
    const nextColors = { ...entryColors, [key]: draft.color };
    const nextLanes = { ...entryLaneOverrides, [key]: draft.laneIds };
    setEntryColors(nextColors);
    setEntryLaneOverrides(nextLanes);
    void savePlacements(nextColors, nextLanes);
    if (selection.kind === "item") {
      const item = items.find(entry => entry.id === selection.id);
      if (!item) return;
      const selectedDepartments = [...new Set(draft.laneIds.flatMap(id => lanes.find(lane => lane.id === id)?.departmentIds ?? []))];
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, notes: draft.description, startTime: draft.start, endTime: draft.end, location: draft.location, itemType: draft.itemType, departmentIds: selectedDepartments }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "日程保存失败");
      setItems(current => current.map(entry => entry.id === item.id ? { ...entry, title: draft.title, notes: draft.description, startTime: draft.start, endTime: draft.end, location: draft.location, itemType: draft.itemType, departmentIds: selectedDepartments } : entry));
    } else {
      const task = eventTasks.find(entry => entry.id === selection.id);
      if (!task) return;
      const departmentId = draft.laneIds.flatMap(id => lanes.find(lane => lane.id === id)?.departmentIds ?? [])[0] ?? task.departmentId;
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${task.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, description: draft.description, startTime: draft.start, endTime: draft.end, status: draft.status, departmentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "任务保存失败");
      setEventTasks(current => current.map(entry => entry.id === task.id ? { ...entry, title: draft.title, description: draft.description, status: draft.status, departmentId, startTime: draft.start, endTime: draft.end, effectiveStartTime: draft.start, effectiveEndTime: draft.end } : entry));
    }
  }

  const editingColumn = columns.find(column => column.id === editingColumnId) ?? null;
  const selectedItem = selectedEntry?.kind === "item" ? items.find(item => item.id === selectedEntry.id) ?? null : null;
  const selectedTask = selectedEntry?.kind === "task" ? eventTasks.find(task => task.id === selectedEntry.id) ?? null : null;
  const selectedLaneIds = selectedEntry
    ? entryLaneOverrides[entryKey(selectedEntry)] ?? lanes.filter(lane => selectedItem ? itemMatchesColumn(selectedItem, lane) : selectedTask ? taskMatchesColumn(selectedTask, lane) : false).map(lane => lane.id)
    : [];

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      {/* timetableHeader */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {event?.startTime ? fmtDate(event.startTime) : "Rundown"}
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            Rundown / 现场执行表
          </h2>
          <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            {event ? [event.location, "15 分钟粒度"].filter(Boolean).join(" · ") : "选择事件查看执行表"}
          </small>
        </div>
        {event && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone="blue">{items.length} 个条目</Badge>
            {eventTasks.length > 0 && <Badge tone="green">{eventTasks.length} 个任务</Badge>}
            {editMode && <button type="button" onClick={() => addColumn("location")} style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)", color: "var(--ink)", padding: "7px 12px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>＋ 新增地点列</button>}
            <button type="button" onClick={() => { setEditMode(value => { const next = !value; if (next) setViewMode("custom"); else { setEditingColumnId(null); setSelectedEntry(null); } return next; }); }} style={{ border: "1px solid var(--ink)", borderRadius: 8, background: editMode ? "var(--ink)" : "transparent", color: editMode ? "#fff" : "var(--ink)", padding: "7px 12px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{editMode ? "完成编辑" : "编辑执行表"}</button>
          </div>
        )}
      </div>

      {/* 版面保存失败要看得见——原来存 localStorage 不会失败，现在会（权限不足、
          归档项目、并发改动），静默吞掉的话 organizer 以为排好了其实没存上 */}
      {layoutError && (
        <p role="alert" style={{
          margin: "0 0 12px", padding: "8px 11px", borderRadius: 8,
          background: "#fdecea", color: "#8c2f22", fontSize: 11, fontWeight: 600,
        }}>
          {layoutError}
          <button type="button" onClick={() => setLayoutError(null)} style={{ marginLeft: 10, border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontWeight: 700 }}>×</button>
        </p>
      )}

      {/* rundownControls（原型：三格卡片行——事件选择 / 工作流筛选 / 当前人说明） */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(210px, 1.25fr) minmax(190px, 1fr) minmax(190px, .8fr)",
        gap: 10, marginBottom: 14,
      }}>
        <label style={CONTROL_CARD}>
          <span style={CONTROL_LABEL}>日期 / 事件</span>
          <select value={eventId} onChange={e => { setEventId(e.target.value); setPersonFilter("all"); }} style={CONTROL_SELECT}>
            {timedEvents.map(e => (
              <option key={e.id} value={e.id}>
                {e.startTime ? `${fmtDate(e.startTime)} · ` : ""}{e.title}
              </option>
            ))}
          </select>
        </label>
        <label style={CONTROL_CARD}>
          <span style={CONTROL_LABEL}>列视图</span>
          <select value={viewMode} onChange={e => setViewMode(e.target.value as "all" | "custom")} style={CONTROL_SELECT}>
            <option value="all">全员视图</option>
            <option value="custom">自定义关注列</option>
          </select>
        </label>
        <label style={CONTROL_CARD}>
          <span style={CONTROL_LABEL}>关注成员</span>
          <select value={personFilter} onChange={e => setPersonFilter(e.target.value)} style={CONTROL_SELECT}>
            <option value="all">全部成员</option>
            {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      {/* 泳道矩阵 */}
      {!event ? (
        <p style={{ margin: 0, padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>暂无带时间的事件。</p>
      ) : loading ? (
        <p style={{ margin: 0, padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>加载中…</p>
      ) : items.length === 0 && eventTasks.length === 0 ? (
        <p style={{ margin: 0, padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
          该事件暂无日程条目。在事件详情页添加日程后此处生成执行表。
        </p>
      ) : (
        /* 原型 rundownMatrixWrap：690px 限高滚动容器 + 38px 横纹底 + sticky 表头/时间列 */
        <div style={{ maxHeight: 690, overflow: "auto", border: "1px solid var(--line)", borderRadius: 11, background: "#f7f7f3" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `86px repeat(${lanes.length}, minmax(145px, 1fr))`,
            gridTemplateRows: `${hasLocationRow ? "34px " : ""}58px repeat(${slots.length}, 38px)`,
            minWidth: 86 + lanes.length * 150,
            position: "relative",
            background: "repeating-linear-gradient(to bottom, transparent 0, transparent 37px, rgba(122,139,134,.18) 37px, rgba(122,139,134,.18) 38px)",
          }}>
            {/* 角格（sticky 双向） */}
            <div style={{
              gridColumn: 1, gridRow: hasLocationRow ? "1 / span 2" : 1, position: "sticky", top: 0, left: 0, zIndex: 30,
              padding: 10, borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
              background: "var(--ink)", color: "#fff", display: "flex", flexDirection: "column",
            }}>
              <b style={{ fontSize: 10 }}>时间</b>
              <small style={{ marginTop: 4, color: "#b9c8c4", fontSize: 8 }}>15 分钟粒度</small>
              {editMode && <button type="button" className={styles.firstInsertButton} aria-label="在第一列前插入人员组" onClick={() => addColumn("people", 0)}><span className={styles.insertColumnGlyph} aria-hidden="true">+</span></button>}
            </div>
            {hasLocationRow && locationSegments.map(segment => (
              <div
                key={segment.key}
                style={{
                  gridColumn: `${segment.start} / span ${segment.span}`, gridRow: 1, position: "sticky", top: 0, zIndex: 16,
                  borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)", padding: "5px 9px",
                  background: segment.label ? "#d9e4e1" : "#edf0ed", color: "var(--ink)", overflow: "hidden",
                }}
                title={segment.label ? `这一列的事项在：${segment.label}` : "这一列的事项没有填地点"}
              >
                <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 9 }}>
                  {segment.label || "未填地点"}
                </b>
              </div>
            ))}
            {/* 泳道表头（sticky top，ink 底白字） */}
            {lanes.map((lane, i) => {
              const frozenIndex = lanes.slice(0, i).filter(column => column.frozen).length;
              return (
                <div
                  key={lane.id}
                  className={styles.rundownColumnHeader}
                  draggable={editMode}
                  onDragStart={event => { if ((event.target as HTMLElement).closest("button")) return; dragColumnId.current = lane.id; event.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={event => { if (dragColumnId.current) event.preventDefault(); }}
                  onDrop={() => dropColumn(lane.id)}
                  onDoubleClick={() => {
                    if (!editMode) return;
                    setSelectedEntry(null);
                    setEditingColumnId(lane.id);
                  }}
                  title={editMode ? "长按拖动调整顺序；双击编辑人员组" : lane.name}
                  style={{
                    gridColumn: i + 2, gridRow: headerRow, position: "sticky", top: hasLocationRow ? 34 : 0,
                    left: lane.frozen ? 86 + frozenIndex * 150 : undefined, zIndex: lane.frozen ? 24 : 14,
                    padding: 10, borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                    background: lane.frozen ? "#294340" : "var(--ink)", color: "#fff", display: "flex", flexDirection: "column",
                    cursor: editMode ? "grab" : "default",
                  }}
                >
                  <b style={{ paddingRight: editMode ? 22 : 0, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lane.frozen ? "▣ " : ""}{lane.name}</b>
                  {editMode && <>
                    <button type="button" draggable={false} className={styles.columnMenuButton} aria-label={`编辑人员组 ${lane.name}`} aria-expanded={editingColumnId === lane.id} onClick={event => { event.stopPropagation(); setSelectedEntry(null); setEditingColumnId(current => current === lane.id ? null : lane.id); }}><span aria-hidden="true">⌄</span></button>
                    <button type="button" draggable={false} className={styles.insertColumnButton} aria-label={`在 ${lane.name} 右侧插入人员组`} onClick={event => { event.stopPropagation(); addColumn("people", i + 1); }}><span className={styles.insertColumnGlyph} aria-hidden="true">+</span></button>
                  </>}
                </div>
              );
            })}
            {/* 时间列（sticky left，#f2f2ed 底，monospace） */}
            {slots.map((m, i) => (
              <div key={m} style={{
                gridColumn: 1, gridRow: i + bodyRowStart, position: "sticky", left: 0, zIndex: 12,
                padding: "7px 8px", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                background: "#f2f2ed", display: "flex", flexDirection: "column",
              }}>
                <b style={{ fontFamily: "monospace", fontSize: 10, color: "var(--ink)" }}>{fmtMin(m)}</b>
                <small style={{ marginTop: 2, color: "var(--muted)", fontSize: 7 }}>{i % 2 === 0 ? "15 min" : ""}</small>
              </div>
            ))}
            {editMode && slots.flatMap((minute, slotIndex) => lanes.map((lane, laneIndex) => (
              <div
                key={`drop-${minute}-${lane.id}`}
                className={styles.rundownDropCell}
                style={{ gridColumn: laneIndex + 2, gridRow: slotIndex + bodyRowStart }}
                onDragOver={event => { if (dragEntryRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                onDrop={event => { event.preventDefault(); void dropEntryAt(lane, minute); }}
                aria-label={`${fmtMin(minute)} ${lane.name} 放置区`}
              />
            )))}
            {/* 条目 cell（原型 rundownCell：2px margin、类型底色、阴影） */}
            {visibleItems.flatMap(it => {
              const selection: RundownEntrySelection = { kind: "item", id: it.id };
              const indexes = laneIndexes(selection, lanes.map((column, index) => itemMatchesColumn(it, column) ? index : -1).filter(index => index >= 0));
              return placements(indexes).map((pl, pi) => {
              const { rowStart, rowSpan } = rowOf(it.startTime!, it.endTime!);
              const tone = ITEM_TONE[it.itemType] ?? ITEM_TONE.custom;
              const dur = minutesOfIso(it.endTime!) - minutesOfIso(it.startTime!);
              const laneIndex = pl.start - 2;
              const frozenIndex = lanes.slice(0, laneIndex).filter(column => column.frozen).length;
              const sticky = pl.span === 1 && lanes[laneIndex]?.frozen;
              const selected = selectedEntry?.kind === "item" && selectedEntry.id === it.id;
              return (
                <article
                  key={`${it.id}-${pi}`}
                  draggable={editMode}
                  onDragStart={event => { if (!editMode) { event.preventDefault(); return; } dragEntryRef.current = { ...selection, duration: dur }; event.dataTransfer.effectAllowed = "move"; }}
                  onClick={() => editMode && setSelectedEntry(selection)}
                  onDoubleClick={() => editMode && setSelectedEntry(selection)}
                  title={editMode ? "拖动到新的人员组或时间；拖动上下边缘调整长度；点击编辑" : it.title}
                  style={{
                  gridColumn: `${pl.start} / span ${pl.span}`,
                  gridRow: `${rowStart} / span ${rowSpan}`,
                  position: sticky ? "sticky" : undefined, left: sticky ? 86 + frozenIndex * 150 : undefined,
                  zIndex: sticky ? 9 : 4, minWidth: 0, margin: 2, padding: "7px 8px", overflow: "hidden",
                  border: `1px solid ${selected ? "#2463d4" : tone.border}`, borderRadius: 7,
                  outline: selected ? "2px solid rgba(36,99,212,.24)" : undefined,
                  background: entryColors[entryKey(selection)] ?? tone.bg, boxShadow: "0 2px 6px rgba(24,42,42,.06)",
                  cursor: editMode ? "move" : "default", userSelect: "none",
                }}>
                  <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 9, whiteSpace: "nowrap", color: "var(--ink)" }}>
                    {it.title}
                  </b>
                  <small style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {dur} min
                  </small>
                  {it.participants.length > 0 && rowSpan >= 2 && (
                    <p style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.participants.map(p => p.name).join(" · ")}
                    </p>
                  )}
                  {editMode && <>
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleTop}`} title="拖动调整开始时间" onPointerDown={event => beginResize(event, selection, "start", it.startTime!, it.endTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleBottom}`} title="拖动调整结束时间" onPointerDown={event => beginResize(event, selection, "end", it.startTime!, it.endTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                  </>}
                </article>
              );
            });})}
            {/* 任务 cell（绑定 event 未绑 schedule；task 草绿调，点击进任务详情） */}
            {visibleTasks.flatMap(t => {
              const selection: RundownEntrySelection = { kind: "task", id: t.id };
              const indexes = laneIndexes(selection, lanes.map((column, index) => taskMatchesColumn(t, column) ? index : -1).filter(index => index >= 0));
              return placements(indexes).map((pl, pi) => {
              const { rowStart, rowSpan } = rowOf(t.effectiveStartTime!, t.effectiveEndTime!);
              const tone = ITEM_TONE.task;
              const dur = minutesOfIso(t.effectiveEndTime!) - minutesOfIso(t.effectiveStartTime!);
              const laneIndex = pl.start - 2;
              const frozenIndex = lanes.slice(0, laneIndex).filter(column => column.frozen).length;
              const sticky = pl.span === 1 && lanes[laneIndex]?.frozen;
              const selected = selectedEntry?.kind === "task" && selectedEntry.id === t.id;
              return (
                <Link
                  key={`task-${t.id}-${pi}`}
                  href={`/production/${productionId}/tasks/${t.id}`}
                  draggable={editMode}
                  onDragStart={event => { if (!editMode) { event.preventDefault(); return; } dragEntryRef.current = { ...selection, duration: dur }; event.dataTransfer.effectAllowed = "move"; }}
                  onClick={event => { if (editMode) { event.preventDefault(); setSelectedEntry(selection); } }}
                  onDoubleClick={event => { if (editMode) { event.preventDefault(); setSelectedEntry(selection); } }}
                  title={editMode ? "拖动到新的人员组或时间；拖动上下边缘调整长度；点击编辑" : `前往任务：${t.title}`}
                  style={{
                    gridColumn: `${pl.start} / span ${pl.span}`,
                    gridRow: `${rowStart} / span ${rowSpan}`,
                    position: sticky ? "sticky" : undefined, left: sticky ? 86 + frozenIndex * 150 : undefined,
                    zIndex: sticky ? 9 : 4, minWidth: 0, margin: 2, padding: "7px 8px", overflow: "hidden",
                    border: `1px ${selected ? "solid" : "dashed"} ${selected ? "#2463d4" : tone.border}`, borderRadius: 7,
                    outline: selected ? "2px solid rgba(36,99,212,.24)" : undefined,
                    background: entryColors[entryKey(selection)] ?? tone.bg, boxShadow: "0 2px 6px rgba(24,42,42,.06)",
                    textDecoration: "none", display: "block", cursor: editMode ? "move" : "pointer", userSelect: "none",
                  }}
                >
                  <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 9, whiteSpace: "nowrap", color: "var(--ink)" }}>
                    任务 · {t.title || "（未命名）"}
                  </b>
                  <small style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[TASK_STATUS_LABELS[t.status] ?? t.status, `${dur} min`].join(" · ")}
                  </small>
                  {t.assignees.length > 0 && rowSpan >= 2 && (
                    <p style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.assignees.map(a => a.name).join(" · ")}
                    </p>
                  )}
                  {editMode && <>
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleTop}`} title="拖动调整开始时间" onPointerDown={event => beginResize(event, selection, "start", t.effectiveStartTime!, t.effectiveEndTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleBottom}`} title="拖动调整结束时间" onPointerDown={event => beginResize(event, selection, "end", t.effectiveStartTime!, t.effectiveEndTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                  </>}
                </Link>
              );
            });})}
          </div>
        </div>
      )}
      {(editingColumn || (editMode && selectedEntry && (selectedItem || selectedTask))) && (
        <button
          type="button"
          className={styles.editorBackdrop}
          aria-label="关闭编辑面板"
          onClick={() => { setEditingColumnId(null); setSelectedEntry(null); }}
        />
      )}
      {editingColumn && <RundownColumnEditor
        column={editingColumn}
        departments={departments}
        members={members}
        roles={roleOptions}
        onChange={patch => updateColumn(editingColumn.id, patch)}
        onRename={name => void saveColumnGroup(editingColumn, { name })}
        onToggleValue={(key, value) => toggleColumnValue(editingColumn.id, key, value)}
        onToggleRole={role => toggleColumnRole(editingColumn.id, role)}
        onDelete={() => removeColumn(editingColumn.id)}
        onClose={() => setEditingColumnId(null)}
      />}
      {editMode && selectedEntry && (selectedItem || selectedTask) && (
        <RundownEntryEditor
          key={entryKey(selectedEntry)}
          selection={selectedEntry}
          item={selectedItem}
          task={selectedTask}
          lanes={lanes.filter(lane => lane.kind === "people")}
          laneIds={selectedLaneIds}
          color={entryColors[entryKey(selectedEntry)] ?? (selectedItem ? (ITEM_TONE[selectedItem.itemType] ?? ITEM_TONE.custom).bg : ITEM_TONE.task.bg)}
          onSave={draft => saveSelectedEntry(selectedEntry, draft)}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </section>
  );
}

const CONTROL_CARD: React.CSSProperties = {
  minWidth: 0, minHeight: 58, padding: "9px 11px",
  border: "1px solid var(--line)", borderRadius: 9, background: "var(--paper)",
  display: "flex", flexDirection: "column", gap: 5,
};
const CONTROL_LABEL: React.CSSProperties = { color: "var(--muted)", fontSize: 8, fontWeight: 700 };
const CONTROL_SELECT: React.CSSProperties = {
  width: "100%", border: 0, background: "transparent", color: "var(--ink)",
  outline: 0, fontSize: 10, fontWeight: 700,
};
// ─── 主组件：三视图 tab ────────────────────────────────────────────────────────

export default function PlanningClient(props: Props) {
  const [mode, setMode] = useState<"calendar" | "gantt" | "timetable">("calendar");
  const [modeRestored, setModeRestored] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(`planning-last-view:${props.productionId}`);
    if (saved === "calendar" || saved === "gantt" || saved === "timetable") setMode(saved);
    setModeRestored(true);
  }, [props.productionId]);

  useEffect(() => {
    if (!modeRestored) return;
    window.localStorage.setItem(`planning-last-view:${props.productionId}`, mode);
  }, [mode, modeRestored, props.productionId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* viewTabs（原型：三等宽撑满、62px 卡、选中 ink 反色） */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {([
          ["calendar", "项目日历", "事件、任务与里程碑"],
          ["gantt", "任务甘特", "任务周期与里程碑标记"],
          ["timetable", "执行日程", "按日期查看、导入与编辑"],
        ] as const).map(([id, label, hint]) => (
          <button
            key={id}
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
            style={{
              border: `1px solid ${mode === id ? "var(--ink)" : "var(--line)"}`,
              borderRadius: 10, background: mode === id ? "var(--ink)" : "var(--surface)",
              minHeight: 62, padding: "12px 15px", display: "flex", flexDirection: "column",
              textAlign: "left", cursor: "pointer",
            }}
          >
            <b style={{ fontSize: 12, color: mode === id ? "#fff" : "var(--ink)" }}>{label}</b>
            <small style={{ color: mode === id ? "#b9c8c4" : "var(--muted)", fontSize: 9, marginTop: 4 }}>{hint}</small>
          </button>
        ))}
      </div>

      {mode === "calendar" && <CalendarView {...props} />}
      {mode === "gantt" && <TaskGanttView {...props} />}
      {mode === "timetable" && <TimetableView {...props} />}
    </div>
  );
}
