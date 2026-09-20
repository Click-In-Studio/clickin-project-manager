"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "@/components/ops/planning.module.css";
import type { ProductionEvent } from "@/lib/ops/event-db";
import { isoCSTDateStr, todayCSTStr } from "@/lib/tz";
import CalendarDetailDrawer, { type CalendarSelection } from "./CalendarDetailDrawer";
import QuickCreateModal from "./QuickCreateModal";
import { ymd } from "./date";
import { PHASE_TONES, phaseTone, phaseRangeLabel, phaseCoversDate } from "./phase";
import { readPref, writePref } from "./prefs";
import type { PlanningMilestone, PlanningTask, Props } from "./types";

export default function CalendarView({ productionId, events, tasks, milestones, phases, departments, editableEventIds, editableTaskIds }: Props) {
  // 「今天」按 CST 算，不按浏览器本地——跨时区的人不该看到不同的当月/今日高亮
  const today = useMemo(() => {
    const [y, m, d] = todayCSTStr().split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }, []);
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());  // 0-based
  const [cursorRestored, setCursorRestored] = useState(false);
  const [quickCreateDate, setQuickCreateDate] = useState<string | null>(null);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);

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
    writePref(
      `planning-calendar-cursor:${productionId}`,
      `${year}-${String(month + 1).padStart(2, "0")}`,
    );
  }, [cursorRestored, month, productionId, year]);

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
    <section className={styles.calendarPanel}>
      <div className={styles.calendarHeader}>
        <div className={styles.calendarHeading}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
            {year} 年
          </p>
          <h2 style={{ margin: "5px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)" }}>
            项目日历
          </h2>
          <small className={styles.calendarDescription}>
            月历统一展示事件、任务、里程碑与阶段；点击事项在右侧查看，点击空白处新建。
          </small>
        </div>
        {/* 月导航 + legend（原型 legend 右上） */}
        <div className={styles.calendarControls}>
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
          <div className={styles.calendarLegend}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--script)" }} />事件
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--stage)" }} />任务
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: "var(--ink)", transform: "rotate(45deg)" }} />里程碑
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 10, height: 4, borderRadius: 2, background: PHASE_TONES[0].solid, opacity: .55 }} />阶段
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
          // 预算按 cell 定高算：桌面 132px 放得下阶段条 + 3 个单行 chip + 提示，手机 2 个。
          // 超出的靠 +N 提示告知，不能靠 overflow:hidden 静默吞掉。
          const shownEntries = dayEntries.slice(0, 3);
          const hidden = Math.max(0, dayEntries.length - shownEntries.length);
          const hiddenOnMobile = Math.max(0, dayEntries.length - 2);
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
              {/* 阶段覆盖：起始日显示名称 chip，其余覆盖日显示细色条延续 */}
              {phases.map((p, pi) => {
                if (!phaseCoversDate(p, date)) return null;
                const phaseStyle = phaseTone(pi);
                const label = p.deptName ? `${p.name}（${p.deptName}）` : p.name;
                return date === p.startDate ? (
                  <span key={p.id} title={`${label} · ${phaseRangeLabel(p)}`} className={styles.calendarChip}
                    style={{ background: phaseStyle.bg, color: phaseStyle.solid, fontWeight: 700 }}>
                    ▸ {label}
                  </span>
                ) : (
                  <i key={p.id} title={`${label} · ${phaseRangeLabel(p)}`}
                    style={{ height: 3, borderRadius: 2, background: phaseStyle.solid, opacity: .4, flexShrink: 0 }} />
                );
              })}
              {shownEntries.map((entry, index) => {
                const entryTitle = entry.kind === "event" ? entry.value.title : entry.kind === "task" ? entry.value.title : entry.value.name;
                const typeLabel = entry.kind === "event" ? "事件" : entry.kind === "task" ? "任务" : "里程碑";
                const tone = entry.kind === "event"
                  ? { background: "var(--script-soft)", color: "var(--script)" }
                  : entry.kind === "task"
                    ? { background: "#f2e3d6", color: "var(--stage)" }
                    : { background: "var(--ink)", color: "#fff" };
                return (
                  <button key={`${entry.kind}-${entry.value.id}`} type="button" className={`${styles.calendarChip} ${index >= 2 ? styles.calendarMobileHidden : ""}`} title={entryTitle} onClick={e => { e.stopPropagation(); setSelection(entry); }} style={tone}>
                    <span className={styles.calendarChipType}>{typeLabel} · </span>{entryTitle}
                  </button>
                );
              })}
              {hidden > 0 && (
                <span className={styles.calendarHiddenDesktop} style={{ fontSize: 8, color: "var(--muted)" }}>+{hidden} 项</span>
              )}
              {hiddenOnMobile > 0 && (
                <span className={styles.calendarHiddenMobile}>+{hiddenOnMobile} 项</span>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 9, color: "var(--muted)" }}>
        点击任意日期空白处可快捷新建事件或任务；新事件保持空流程，由用户按真实安排添加第一项。绑定事件的任务随事件显示，不单独占格。
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
          <CalendarDetailDrawer
            key={`${selection.kind}-${selection.value.id}`}
            productionId={productionId}
            selection={selection}
            canEdit={selection.kind === "event"
              ? editableEventIds.includes(selection.value.id)
              : selection.kind === "task" && editableTaskIds.includes(selection.value.id)}
            onSaved={setSelection}
            onClose={() => setSelection(null)}
          />
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
