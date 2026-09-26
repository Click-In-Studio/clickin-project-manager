"use client";

import { useEffect, useRef } from "react";
import styles from "@/components/ops/planning.module.css";
import type { CalendarSelection } from "./CalendarDetailDrawer";

function entryLabel(entry: CalendarSelection) {
  if (entry.kind === "event") return { type: "事件", title: entry.value.title };
  if (entry.kind === "task") return { type: "任务", title: entry.value.title };
  return { type: "里程碑", title: entry.value.name };
}

export default function CalendarDayDrawer({ date, entries, onSelect, onClose }: {
  date: string;
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
      className={`${styles.detailDrawer} ${styles.calendarDayDrawer}`}
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
          <h2 id="calendar-day-drawer-title" className={styles.calendarDayDrawerTitle}>当天事项</h2>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="关闭当天事项"
          onClick={onClose}
          className={styles.drawerCloseButton}
        >
          ×
        </button>
      </header>

      <div className={styles.calendarDayDrawerBody}>
        {entries.length === 0 ? (
          <div className={styles.calendarDayEmpty}>
            <b>当天暂无事项</b>
            <span>可使用右下角“＋”快速新建事件或任务。</span>
          </div>
        ) : (
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
        )}
      </div>
    </aside>
  );
}
