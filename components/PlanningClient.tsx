"use client";

/**
 * 计划与日程（v3 原型 planning 三视图）：
 *   ① 项目日历 —— 月历统一展示事件、任务（未绑定 event 的）与里程碑
 *   ② 任务甘特 —— 任务时间条（有效起止：自身→schedule→event 解析链），可拖拽改期
 *   ③ 执行日程 —— 按事件的多部门 rundown（schedule 条目 + 绑定 event 未绑 schedule 的任务）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import Badge from "@/components/Badge";
import type { ProductionEvent, EventScheduleItemWithParticipants, EventTechReq } from "@/lib/event-db";

type PlanningMilestone = { id: string; name: string; endDate: string };
type PlanningDept = { id: string; name: string };

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
};

type Props = {
  productionId: string;
  events: ProductionEvent[];
  tasks: PlanningTask[];
  milestones: PlanningMilestone[];
  departments: PlanningDept[];
};

const TASK_STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── 项目日历 ─────────────────────────────────────────────────────────────────

function CalendarView({ productionId, events, tasks, milestones }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());  // 0-based

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
      entry(ymd(new Date(ev.startTime))).events.push(ev);
    }
    for (const t of standaloneTasks) {
      entry(ymd(new Date(t.effectiveStartTime!))).tasks.push(t);
    }
    for (const m of milestones) {
      entry(m.endDate.slice(0, 10)).milestones.push(m);
    }
    return map;
  }, [events, standaloneTasks, milestones]);

  // 周一起始月网格（原型为 4 周静态；实装整月 6 周）
  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [year, month]);

  const move = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const todayStr = ymd(today);

  // 原型 CalendarMock：panel + panelHeading(kicker/h2/legend) + calendarWeek + calendarGrid + hint
  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {year} 年 {month + 1} 月
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            项目日历
          </h2>
          <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            月历统一展示事件、任务与里程碑；点击条目直接打开。
          </small>
        </div>
        {/* 月导航 + legend（原型 legend 右上） */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => move(-1)} aria-label="上一月" style={CAL_NAV_BTN}>‹</button>
            <button
              onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth()); }}
              style={{ ...CAL_NAV_BTN, width: "auto", padding: "0 8px", fontSize: 10, fontWeight: 700 }}
            >
              今天
            </button>
            <button onClick={() => move(1)} aria-label="下一月" style={CAL_NAV_BTN}>›</button>
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
          const inMonth = d.getMonth() === month;
          const day = byDate.get(date);
          const isToday = date === todayStr;
          const shownEvents = day?.events.slice(0, 3) ?? [];
          const shownTasks = day?.tasks.slice(0, Math.max(0, 5 - shownEvents.length - (day?.milestones.length ?? 0))) ?? [];
          const hidden = day
            ? (day.events.length - shownEvents.length) + (day.tasks.length - shownTasks.length)
            : 0;
          return (
            <div
              key={date}
              style={{
                minWidth: 0, minHeight: 93, padding: 7,
                borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                display: "flex", flexDirection: "column", gap: 4,
                background: isToday ? "#f8f0e7" : undefined,
                opacity: inMonth ? 1 : 0.45,
              }}
            >
              <b style={{ fontSize: 9, color: "var(--muted)" }}>{d.getDate()}</b>
              {day?.milestones.map(m => (
                <span key={m.id} title={m.name} style={{ ...CAL_CHIP, background: "var(--ink)", color: "#fff" }}>
                  ◆ {m.name}
                </span>
              ))}
              {shownEvents.map(ev => (
                <Link
                  key={ev.id}
                  href={`/production/${productionId}/events/${ev.id}`}
                  title={`${ev.title}${ev.startTime ? ` · ${hhmm(ev.startTime)}` : ""}`}
                  style={{ ...CAL_CHIP, background: "var(--script-soft)", color: "var(--script)", textDecoration: "none", display: "block" }}
                >
                  事件 · {ev.title}
                </Link>
              ))}
              {shownTasks.map(t => (
                <Link
                  key={t.id}
                  href={`/production/${productionId}/tasks/${t.id}`}
                  title={`${t.title} · ${TASK_STATUS_LABELS[t.status] ?? t.status}${t.departmentName ? ` · ${t.departmentName}` : ""}`}
                  style={{ ...CAL_CHIP, background: "#f2e3d6", color: "var(--stage)", textDecoration: "none", display: "block" }}
                >
                  任务 · {t.title}
                </Link>
              ))}
              {hidden > 0 && (
                <span style={{ fontSize: 8, color: "var(--muted)" }}>+{hidden} 项</span>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 9, color: "var(--muted)" }}>
        绑定事件的任务随事件显示，不单独占格；未绑定事件的任务按有效开始日期上历。
      </p>
    </section>
  );
}

const CAL_NAV_BTN: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: "1px solid var(--line)",
  background: "var(--surface)", color: "var(--muted)", cursor: "pointer",
  fontSize: 13, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
};
const CAL_CHIP: React.CSSProperties = {
  border: 0, borderRadius: 4, padding: 5, textAlign: "left", fontSize: 8, cursor: "pointer",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
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

function minutesOfIso(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function fmtMin(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function TimetableView({ productionId, events, departments }: Props) {
  const timedEvents = useMemo(
    () => events.filter(e => e.startTime).sort((a, b) => (a.startTime! < b.startTime! ? -1 : 1)),
    [events],
  );
  const [eventId, setEventId] = useState<string>(timedEvents[0]?.id ?? "");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [items, setItems] = useState<EventScheduleItemWithParticipants[]>([]);
  const [eventTasks, setEventTasks] = useState<EventTechReq[]>([]);
  const [loading, setLoading] = useState(false);

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

  // 泳道 = schedule 条目 + 任务涉及的部门（保持 departments 原序）；无部门项跨全泳道
  const lanes = useMemo(() => {
    const used = new Set<string>([
      ...items.flatMap(it => it.departmentIds),
      ...eventTasks.map(t => t.departmentId).filter((v): v is string => !!v),
    ]);
    const named = departments.filter(d => used.has(d.id));
    return named.length ? named : [{ id: "__all", name: "全体" }];
  }, [items, eventTasks, departments]);

  // 人员选项：schedule 参与人 + 任务 assignee 聚合
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) for (const p of it.participants) m.set(p.userId, p.name);
    for (const t of eventTasks) for (const a of t.assignees) m.set(a.userId, a.name);
    return [...m.entries()];
  }, [items, eventTasks]);

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

  // lane 放置：连续部门合并 span，非连续拆多块；无部门=跨全泳道（原型 gridPlacements）
  function placements(deptIds: string[]): { start: number; span: number }[] {
    if (deptIds.length === 0) return [{ start: 2, span: lanes.length }];
    const idx = deptIds
      .map(id => lanes.findIndex(l => l.id === id))
      .filter(i => i >= 0)
      .sort((a, b) => a - b);
    if (!idx.length) return [{ start: 2, span: lanes.length }];
    const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    return contiguous
      ? [{ start: idx[0] + 2, span: idx[idx.length - 1] - idx[0] + 1 }]
      : idx.map(i => ({ start: i + 2, span: 1 }));
  }

  function rowOf(startIso: string, endIso: string): { rowStart: number; rowSpan: number } {
    const rowStart = Math.max(2, Math.floor((minutesOfIso(startIso) - startMin) / SLOT) + 2);
    const rowSpan = Math.max(1, Math.ceil((minutesOfIso(endIso) - minutesOfIso(startIso)) / SLOT));
    return { rowStart, rowSpan };
  }

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      {/* timetableHeader */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {event?.startTime ? `${new Date(event.startTime).getMonth() + 1} 月 ${new Date(event.startTime).getDate()} 日` : "Rundown"}
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            Rundown / 现场执行表
          </h2>
          <small style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            {event ? [event.location, "15 分钟粒度"].filter(Boolean).join(" · ") : "选择事件查看执行表"}
          </small>
        </div>
        {event && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
            <Badge tone="blue">{items.length} 个条目</Badge>
            {eventTasks.length > 0 && <Badge tone="green">{eventTasks.length} 个任务</Badge>}
          </div>
        )}
      </div>

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
                {e.startTime ? `${new Date(e.startTime).getMonth() + 1} 月 ${new Date(e.startTime).getDate()} 日 · ` : ""}{e.title}
              </option>
            ))}
          </select>
        </label>
        <label style={CONTROL_CARD}>
          <span style={CONTROL_LABEL}>查看工作流</span>
          <select value={personFilter} onChange={e => setPersonFilter(e.target.value)} style={CONTROL_SELECT}>
            <option value="all">全部成员</option>
            {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <p style={{ ...CONTROL_CARD, display: "flex", flexDirection: "column", justifyContent: "center", margin: 0 }}>
          <b style={{ fontSize: 11, color: "var(--ink)" }}>
            {personFilter === "all" ? "全部成员" : people.find(([id]) => id === personFilter)?.[1] ?? "全部成员"}
          </b>
          <small style={{ marginTop: 4, color: "var(--muted)", fontSize: 8 }}>可查看其当前工作与工作地点</small>
        </p>
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
            gridTemplateRows: `58px repeat(${slots.length}, 38px)`,
            minWidth: 86 + lanes.length * 150,
            position: "relative",
            background: "repeating-linear-gradient(to bottom, transparent 0, transparent 37px, rgba(122,139,134,.18) 37px, rgba(122,139,134,.18) 38px)",
          }}>
            {/* 角格（sticky 双向） */}
            <div style={{
              gridColumn: 1, gridRow: 1, position: "sticky", top: 0, left: 0, zIndex: 10,
              padding: 10, borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
              background: "var(--ink)", color: "#fff", display: "flex", flexDirection: "column",
            }}>
              <b style={{ fontSize: 10 }}>时间</b>
              <small style={{ marginTop: 4, color: "#b9c8c4", fontSize: 8 }}>地点 / 时长</small>
            </div>
            {/* 泳道表头（sticky top，ink 底白字） */}
            {lanes.map((lane, i) => (
              <div key={lane.id} style={{
                gridColumn: i + 2, gridRow: 1, position: "sticky", top: 0, zIndex: 8,
                padding: 10, borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                background: "var(--ink)", color: "#fff", display: "flex", flexDirection: "column",
              }}>
                <b style={{ fontSize: 10 }}>{lane.name}</b>
              </div>
            ))}
            {/* 时间列（sticky left，#f2f2ed 底，monospace） */}
            {slots.map((m, i) => (
              <div key={m} style={{
                gridColumn: 1, gridRow: i + 2, position: "sticky", left: 0, zIndex: 5,
                padding: "7px 8px", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                background: "#f2f2ed", display: "flex", flexDirection: "column",
              }}>
                <b style={{ fontFamily: "monospace", fontSize: 10, color: "var(--ink)" }}>{fmtMin(m)}</b>
                <small style={{ marginTop: 2, color: "var(--muted)", fontSize: 7 }}>{i % 2 === 0 ? "15 min" : ""}</small>
              </div>
            ))}
            {/* 条目 cell（原型 rundownCell：2px margin、类型底色、阴影） */}
            {visibleItems.flatMap(it => placements(it.departmentIds).map((pl, pi) => {
              const { rowStart, rowSpan } = rowOf(it.startTime!, it.endTime!);
              const tone = ITEM_TONE[it.itemType] ?? ITEM_TONE.custom;
              const dur = minutesOfIso(it.endTime!) - minutesOfIso(it.startTime!);
              return (
                <article key={`${it.id}-${pi}`} style={{
                  gridColumn: `${pl.start} / span ${pl.span}`,
                  gridRow: `${rowStart} / span ${rowSpan}`,
                  zIndex: 3, minWidth: 0, margin: 2, padding: "7px 8px", overflow: "hidden",
                  border: `1px solid ${tone.border}`, borderRadius: 7,
                  background: tone.bg, boxShadow: "0 2px 6px rgba(24,42,42,.06)",
                }}>
                  <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 9, whiteSpace: "nowrap", color: "var(--ink)" }}>
                    {it.title}
                  </b>
                  <small style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[it.location, `${dur} min`].filter(Boolean).join(" · ")}
                  </small>
                  {it.participants.length > 0 && rowSpan >= 2 && (
                    <p style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.participants.map(p => p.name).join(" · ")}
                    </p>
                  )}
                </article>
              );
            }))}
            {/* 任务 cell（绑定 event 未绑 schedule；task 草绿调，点击进任务详情） */}
            {visibleTasks.flatMap(t => placements(t.departmentId ? [t.departmentId] : []).map((pl, pi) => {
              const { rowStart, rowSpan } = rowOf(t.effectiveStartTime!, t.effectiveEndTime!);
              const tone = ITEM_TONE.task;
              const dur = minutesOfIso(t.effectiveEndTime!) - minutesOfIso(t.effectiveStartTime!);
              return (
                <Link
                  key={`task-${t.id}-${pi}`}
                  href={`/production/${productionId}/tasks/${t.id}`}
                  style={{
                    gridColumn: `${pl.start} / span ${pl.span}`,
                    gridRow: `${rowStart} / span ${rowSpan}`,
                    zIndex: 3, minWidth: 0, margin: 2, padding: "7px 8px", overflow: "hidden",
                    border: `1px dashed ${tone.border}`, borderRadius: 7,
                    background: tone.bg, boxShadow: "0 2px 6px rgba(24,42,42,.06)",
                    textDecoration: "none", display: "block",
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
                </Link>
              );
            }))}
          </div>
        </div>
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
