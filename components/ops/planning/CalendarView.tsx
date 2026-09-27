"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "@/components/ops/planning.module.css";
import type { ProductionEvent } from "@/lib/ops/event-db";
import { isoCSTDateStr, todayCSTStr } from "@/lib/tz";
import CalendarDayDrawer from "./CalendarDayDrawer";
import CalendarDetailDrawer, { type CalendarSelection } from "./CalendarDetailDrawer";
import QuickCreateModal from "./QuickCreateModal";
import { ymd } from "./date";
import { PHASE_TONES, phaseTone, phaseRangeLabel, phaseCoversDate } from "./phase";
import { readPref, writePref } from "./prefs";
import type { PlanningMilestone, PlanningTask, Props } from "./types";

type DayEntries = { events: ProductionEvent[]; tasks: PlanningTask[]; milestones: PlanningMilestone[] };

function toSelections(day?: DayEntries): CalendarSelection[] {
  if (!day) return [];
  return [
    ...day.milestones.map(value => ({ kind: "milestone" as const, value })),
    ...day.events.map(value => ({ kind: "event" as const, value })),
    ...day.tasks.map(value => ({ kind: "task" as const, value })),
  ];
}

function entryMeta(entry: CalendarSelection) {
  if (entry.kind === "event") return { title: entry.value.title, type: "事件", tone: { background: "var(--script-soft)", color: "var(--script)" } };
  if (entry.kind === "task") return { title: entry.value.title, type: "任务", tone: { background: "#f2e3d6", color: "var(--stage)" } };
  return { title: entry.value.name, type: "里程碑", tone: { background: "var(--ink)", color: "#fff" } };
}

export default function CalendarView({ productionId, events, tasks, milestones, phases, departments, editableEventIds, editableTaskIds }: Props) {
  // 「今天」按 CST 算，不按浏览器本地——跨时区的人不该看到不同的当月/今日高亮
  const today = useMemo(() => {
    const [y, m, d] = todayCSTStr().split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }, []);
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());
  const [cursorRestored, setCursorRestored] = useState(false);
  const [quickCreateDate, setQuickCreateDate] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [returnToDate, setReturnToDate] = useState<string | null>(null);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const saved = readPref(`planning-calendar-cursor:${productionId}`);
    const matched = saved?.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (matched) {
      setYear(Number(matched[1]));
      setMonth(Number(matched[2]) - 1);
    }
    setCursorRestored(true);
  }, [productionId]);

  useEffect(() => {
    if (!cursorRestored) return;
    writePref(`planning-calendar-cursor:${productionId}`, `${year}-${String(month + 1).padStart(2, "0")}`);
  }, [cursorRestored, month, productionId, year]);

  const standaloneTasks = useMemo(() => tasks.filter(task => !task.eventId && task.effectiveStartTime), [tasks]);
  const byDate = useMemo(() => {
    const map = new Map<string, DayEntries>();
    const entry = (date: string) => {
      if (!map.has(date)) map.set(date, { events: [], tasks: [], milestones: [] });
      return map.get(date)!;
    };
    for (const event of events) {
      if (!event.startTime || event.status === "cancelled") continue;
      entry(isoCSTDateStr(event.startTime)).events.push(event);
    }
    for (const task of standaloneTasks) entry(isoCSTDateStr(task.effectiveStartTime!)).tasks.push(task);
    for (const milestone of milestones) entry(milestone.endDate.slice(0, 10)).milestones.push(milestone);
    return map;
  }, [events, milestones, standaloneTasks]);

  // 周一起始月网格；用 Date.UTC 保证格子在不同时区都指向同一个 CST 日期。
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(year, month, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) => new Date(Date.UTC(year, month, 1 - lead + index)));
  }, [month, year]);

  const todayStr = ymd(today);
  const expandedEntries = toSelections(expandedDate ? byDate.get(expandedDate) : undefined);

  const move = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth());
  };
  const rememberTrigger = (trigger: HTMLElement) => { lastTriggerRef.current = trigger; };
  const restoreTrigger = () => window.requestAnimationFrame(() => lastTriggerRef.current?.focus());
  const closeQuickCreate = () => { setQuickCreateDate(null); restoreTrigger(); };
  const closeDay = () => { setExpandedDate(null); restoreTrigger(); };
  const closeDetail = () => { setSelection(null); setReturnToDate(null); restoreTrigger(); };
  const openDay = (date: string, trigger: HTMLElement) => {
    rememberTrigger(trigger);
    setSelectedDate(date);
    setExpandedDate(date);
  };
  const openQuickCreate = (date: string, trigger: HTMLElement) => {
    rememberTrigger(trigger);
    setSelectedDate(date);
    setQuickCreateDate(date);
  };
  const openDetail = (entry: CalendarSelection, trigger: HTMLElement, date: string) => {
    rememberTrigger(trigger);
    setSelectedDate(date);
    setReturnToDate(null);
    setSelection(entry);
  };
  const openDetailFromDay = (entry: CalendarSelection) => {
    setReturnToDate(expandedDate);
    setExpandedDate(null);
    setSelection(entry);
  };
  const activateDate = (date: string, trigger: HTMLElement) => {
    if (window.matchMedia("(max-width: 760px)").matches) openDay(date, trigger);
    else openQuickCreate(date, trigger);
  };

  return (
    <section className={styles.calendarPanel}>
      <div className={styles.calendarHeader}>
        <div className={styles.calendarHeading}>
          <p className={styles.calendarYear}>{year} 年</p>
          <h2 className={styles.calendarTitle}>项目日历</h2>
          <small className={styles.calendarDescription}>月历统一展示事件、任务、里程碑与阶段；点击事项查看详情。</small>
        </div>
        <div className={styles.calendarControls}>
          <div className={styles.calendarNavGroup}>
            <button type="button" onClick={() => { setYear(today.getUTCFullYear()); setMonth(today.getUTCMonth()); }} className={styles.calendarTodayButton}>定位至今天</button>
            <div className={styles.calendarPager}>
              <button type="button" onClick={() => move(-1)} aria-label="上一月" className={styles.calendarNavButton}>‹</button>
              <span aria-label={`当前月份 ${month + 1}月`} className={styles.calendarMonthLabel}>{month + 1}月</span>
              <button type="button" onClick={() => move(1)} aria-label="下一月" className={styles.calendarNavButton}>›</button>
            </div>
          </div>
          <div className={styles.calendarLegend}>
            <span><i style={{ background: "var(--script)" }} />事件</span>
            <span><i style={{ background: "var(--stage)" }} />任务</span>
            <span><i className={styles.calendarLegendMilestone} style={{ background: "var(--ink)" }} />里程碑</span>
            <span><i className={styles.calendarLegendPhase} style={{ background: PHASE_TONES[0].solid }} />阶段</span>
          </div>
        </div>
      </div>

      <div className={styles.calendarWeek}>
        {["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>周{day}</span>)}
      </div>
      <div className={styles.calendarGrid}>
        {cells.map(dateValue => {
          const date = ymd(dateValue);
          const inMonth = dateValue.getUTCMonth() === month;
          const entries = toSelections(byDate.get(date));
          const shownEntries = entries.slice(0, 3);
          const hidden = Math.max(0, entries.length - 3);
          const hiddenOnMobile = Math.max(0, entries.length - 2);
          return (
            <div
              key={date}
              data-calendar-date={date}
              className={`${styles.calendarCell} ${date === todayStr ? styles.calendarCellToday : ""} ${selectedDate === date ? styles.calendarCellSelected : ""}`}
              style={{ opacity: inMonth ? 1 : 0.45 }}
              onClick={event => {
                if ((event.target as HTMLElement).closest("button,a")) return;
                activateDate(date, event.currentTarget);
              }}
            >
              <button
                type="button"
                className={styles.calendarDateButton}
                aria-label={`${date}，${entries.length ? `${entries.length} 项` : "暂无事项"}`}
                title="查看或操作当天事项"
                onClick={event => { event.stopPropagation(); activateDate(date, event.currentTarget); }}
              >
                {dateValue.getUTCDate()}
              </button>
              {phases.map((phase, index) => {
                if (!phaseCoversDate(phase, date)) return null;
                const tone = phaseTone(index);
                const label = phase.deptName ? `${phase.name}（${phase.deptName}）` : phase.name;
                return date === phase.startDate ? (
                  <span key={phase.id} title={`${label} · ${phaseRangeLabel(phase)}`} className={`${styles.calendarChip} ${styles.calendarPhaseChip}`} style={{ background: tone.bg, color: tone.solid }}>
                    <span className={styles.calendarChipTitle}>▸ {label}</span>
                  </span>
                ) : (
                  <i key={phase.id} title={`${label} · ${phaseRangeLabel(phase)}`} className={styles.calendarPhaseBar} style={{ background: tone.solid }} />
                );
              })}
              {shownEntries.map((entry, index) => {
                const meta = entryMeta(entry);
                return (
                  <button
                    key={`${entry.kind}-${entry.value.id}`}
                    type="button"
                    className={`${styles.calendarChip} ${index >= 2 ? styles.calendarMobileHidden : ""}`}
                    title={meta.title}
                    onClick={event => { event.stopPropagation(); openDetail(entry, event.currentTarget, date); }}
                    style={meta.tone}
                  >
                    <span className={styles.calendarChipType}>{meta.type} · </span>
                    <span className={styles.calendarChipTitle}>{meta.title}</span>
                  </button>
                );
              })}
              {hidden > 0 && (
                <button type="button" className={styles.calendarHiddenDesktop} onClick={event => { event.stopPropagation(); openDay(date, event.currentTarget); }}>+{hidden} 项</button>
              )}
              {hiddenOnMobile > 0 && (
                <button type="button" className={styles.calendarHiddenMobile} onClick={event => { event.stopPropagation(); openDay(date, event.currentTarget); }}>+{hiddenOnMobile} 项</button>
              )}
            </div>
          );
        })}
      </div>
      <p className={styles.calendarHint}>
        桌面端点击日期空白处可快捷新建；移动端点击日期查看当天事项，并使用右下角“＋”新建。绑定事件的任务随事件显示，不单独占格。
      </p>

      <button
        type="button"
        className={styles.calendarFloatingCreate}
        aria-label={`在${selectedDate ?? todayStr}快捷新建事件或任务`}
        title={`新建到 ${selectedDate ?? todayStr}`}
        onClick={event => openQuickCreate(selectedDate ?? todayStr, event.currentTarget)}
      >
        ＋
      </button>

      {quickCreateDate && <QuickCreateModal productionId={productionId} date={quickCreateDate} departments={departments} events={events} onClose={closeQuickCreate} />}
      {(expandedDate || selection) && (
        <button type="button" tabIndex={-1} className={styles.drawerBackdrop} aria-label="关闭日历弹层" onClick={selection ? closeDetail : closeDay} />
      )}
      {expandedDate && <CalendarDayDrawer date={expandedDate} entries={expandedEntries} onSelect={openDetailFromDay} onClose={closeDay} />}
      {selection && (
        <CalendarDetailDrawer
          key={`${selection.kind}-${selection.value.id}`}
          productionId={productionId}
          selection={selection}
          canEdit={selection.kind === "event"
            ? editableEventIds.includes(selection.value.id)
            : selection.kind === "task" && editableTaskIds.includes(selection.value.id)}
          onSaved={setSelection}
          onBack={returnToDate ? () => { setSelection(null); setExpandedDate(returnToDate); setReturnToDate(null); } : undefined}
          onClose={closeDetail}
        />
      )}
    </section>
  );
}
