"use client";

import { useEffect, useRef } from "react";
import styles from "@/components/ops/planning.module.css";
import type { CalendarSelection } from "./CalendarDetailDrawer";
import { phaseRangeLabel } from "./phase";
import type { PlanningPhase } from "./types";

function entryLabel(entry: CalendarSelection) {
  if (entry.kind === "event") return { type: "事件", title: entry.value.title };
  if (entry.kind === "task") return { type: "任务", title: entry.value.title };
  return { type: "里程碑", title: entry.value.name };
}

export default function CalendarDayDrawer({ date, phases, entries, onSelect, onClose }: {
  date: string;
  phases: PlanningPhase[];
  entries: CalendarSelection[];
  onSelect: (entry: CalendarSelection) => void;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <aside
      className={`app-mobile-input-overlay app-mobile-input-surface ${styles.detailDrawer} ${styles.calendarDayDrawer}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-day-drawer-title"
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className={styles.calendarDayDrawerHeader}>
        <div>
          <p className={styles.calendarDayDrawerDate}>{date}</p>
          <h2 id="calendar-day-drawer-title" className={styles.calendarDayDrawerTitle}>当天安排</h2>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="关闭当天安排"
          onClick={onClose}
          className={styles.drawerCloseButton}
        >
          ×
        </button>
      </header>

      <div className={styles.calendarDayDrawerBody}>
        {phases.length === 0 && entries.length === 0 ? (
          <div className={styles.calendarDayEmpty}>
            <b>当天暂无安排</b>
            <span>可使用右下角“＋”快速新建事件或任务。</span>
          </div>
        ) : (
          <div className={styles.calendarDaySections}>
            {phases.length > 0 && (
              <section aria-labelledby="calendar-day-phases-title">
                <h3 id="calendar-day-phases-title" className={styles.calendarDaySectionTitle}>阶段</h3>
                <ul className={styles.calendarDayList}>
                  {phases.map(phase => (
                    <li key={phase.id} className={`${styles.calendarDayItem} ${styles.calendarDayPhaseItem}`}>
                      <span className={`${styles.calendarDayType} ${styles.calendarDayTypephase}`}>阶段</span>
                      <span className={styles.calendarDayItemTitle}>
                        <b>{phase.name}</b>
                        <small>{phase.deptName ?? "全项目"} · {phaseRangeLabel(phase)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {entries.length > 0 && (
              <section aria-labelledby="calendar-day-entries-title">
                <h3 id="calendar-day-entries-title" className={styles.calendarDaySectionTitle}>事项</h3>
                <ul className={styles.calendarDayList}>
                  {entries.map(entry => {
                    const label = entryLabel(entry);
                    return (
                      <li key={`${entry.kind}-${entry.value.id}`}>
                        <button type="button" onClick={() => onSelect(entry)} className={styles.calendarDayItem}>
                          <span className={`${styles.calendarDayType} ${styles[`calendarDayType${entry.kind}`]}`}>{label.type}</span>
                          <span className={styles.calendarDayItemTitle}>{label.title}</span>
                          <span aria-hidden="true" className={styles.calendarDayItemArrow}>›</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
