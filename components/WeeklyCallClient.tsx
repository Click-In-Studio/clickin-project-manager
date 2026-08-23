"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { MyScheduleEntry, WeeklyCallEvent } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import styles from "@/components/my-pages.module.css";

type CalendarView = "week" | "month" | "agenda";
type ApiResponse = {
  events: WeeklyCallEvent[];
  calendarEntries: MyScheduleEntry[];
  view: CalendarView;
  anchor: string;
  rangeStart: string;
  rangeEnd: string;
};

const DAY = 86_400_000;
const VIEW_LABELS: { id: CalendarView; label: string }[] = [
  { id: "week", label: "周视图" },
  { id: "month", label: "月视图" },
  { id: "agenda", label: "日程表" },
];

function cstDate(iso: string) {
  return new Date(new Date(iso).getTime() + 8 * 3_600_000);
}
function fmtDate(iso: string) {
  const d = cstDate(iso);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
function fmtTime(iso: string) {
  const d = cstDate(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function fmtDow(iso: string) {
  return "周" + "日一二三四五六"[cstDate(iso).getUTCDay()];
}
function isoDateCST(iso: string) {
  const d = cstDate(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function shiftDate(value: string, amount: number, unit: "day" | "month") {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (unit === "month") date.setUTCMonth(date.getUTCMonth() + amount, 1);
  else date.setUTCDate(date.getUTCDate() + amount);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export default function WeeklyCallClient({ token }: { token?: string } = {}) {
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState("");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams({ view });
    if (anchor) params.set("anchor", anchor);
    if (token) params.set("t", token);
    setLoading(true);
    fetch(`${BASE_PATH}/api/my/weekly-call?${params.toString()}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token, view, anchor]);

  const events = useMemo(() => data?.events ?? [], [data]);
  const calendarEntries = useMemo(() => data?.calendarEntries ?? [], [data]);
  const rangeStart = data?.rangeStart ?? "";
  const rangeEnd = data?.rangeEnd ?? "";
  const todayIso = isoDateCST(new Date().toISOString());

  const byDateKey = useMemo(() => {
    const grouped = new Map<string, MyScheduleEntry[]>();
    for (const entry of calendarEntries) {
      const key = isoDateCST(entry.startsAt);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(entry);
    }
    return grouped;
  }, [calendarEntries]);

  const calendarDays = rangeStart && rangeEnd
    ? Array.from({ length: Math.round((new Date(rangeEnd).getTime() - new Date(rangeStart).getTime()) / DAY) }, (_, index) => {
        const iso = new Date(new Date(rangeStart).getTime() + index * DAY).toISOString();
        const shifted = cstDate(iso);
        const isoDate = isoDateCST(iso);
        return {
          iso,
          isoDate,
          date: shifted.getUTCDate(),
          month: shifted.getUTCMonth(),
          entries: byDateKey.get(isoDate) ?? [],
        };
      })
    : [];

  const activeAnchor = data?.anchor || anchor || todayIso;
  const anchorMonth = Number(activeAnchor.slice(5, 7)) - 1;
  const rangeLabel = view === "month"
    ? `${activeAnchor.slice(0, 4)}年${Number(activeAnchor.slice(5, 7))}月`
    : rangeStart && rangeEnd
      ? `${fmtDate(rangeStart)} – ${fmtDate(new Date(new Date(rangeEnd).getTime() - DAY).toISOString())}`
      : "";

  const changePeriod = (direction: -1 | 1) => {
    const base = activeAnchor;
    setAnchor(shiftDate(base, direction * (view === "week" ? 7 : view === "agenda" ? 30 : 1), view === "month" ? "month" : "day"));
  };

  return (
    <div className={styles.workspace}>
      <div className={styles.calendarHeader}>
        <div className={styles.pageHeader} style={{ margin: 0 }}>
          <p className={styles.eyebrow}>Platform · 日程</p>
          <h1 className={styles.pageTitle}>{view === "week" ? "本周日程" : view === "month" ? "月历" : "日程表"}</h1>
          {rangeLabel && <p className={styles.calendarRange}>{rangeLabel} · UTC+8</p>}
          {view !== "week" && <p className={styles.calendarLegend}><b>Call</b> 高亮显示 · 事件、任务与流程项淡显</p>}
        </div>
        <div className={styles.calendarControls} aria-label="日历视图控制">
          <div className={styles.calendarPager}>
            <button type="button" onClick={() => changePeriod(-1)} aria-label="上一周期">‹</button>
            <button type="button" onClick={() => setAnchor("")}>今天</button>
            <button type="button" onClick={() => changePeriod(1)} aria-label="下一周期">›</button>
          </div>
          <div className={styles.calendarViewSwitch} role="tablist" aria-label="切换日历视图">
            {VIEW_LABELS.map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                onClick={() => { setView(item.id); setAnchor(""); }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>加载中…</div>
      ) : (
        <>
          {view === "week" && (
            <div className={styles.weekGridScroll}>
              <div className={styles.weekGrid}>
                {calendarDays.slice(0, 7).map((day, index) => (
                  <Link key={day.isoDate} href={`/my/daily-call?date=${day.isoDate}`} className={`${styles.weekDay} ${styles.weekDayLink}`}>
                    <div className={styles.weekDayLabel}>{["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][index]}</div>
                    <div className={`${styles.weekDayDate} ${day.isoDate === todayIso ? styles.today : ""}`}>{day.date}</div>
                    {events.flatMap(event => event.calls.filter(call => isoDateCST(call.callAt) === day.isoDate).map(call => (
                      <span key={`${event.eventId}-${call.callAt}`} className={styles.weekCallPill}>{fmtTime(call.callAt)} <small>{event.eventTitle}</small></span>
                    )))}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {view === "month" && (
            <div className={styles.monthGridWrap}>
              <div className={styles.monthWeekdays}>{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>周{day}</span>)}</div>
              <div className={styles.monthGrid}>
                {calendarDays.map(day => (
                  <div key={day.isoDate} className={`${styles.monthDay} ${day.month !== anchorMonth ? styles.monthDayMuted : ""}`}>
                    <Link href={`/my/daily-call?date=${day.isoDate}`} className={`${styles.monthDayNumber} ${day.isoDate === todayIso ? styles.monthToday : ""}`}>{day.date}</Link>
                    <span className={styles.monthDayEvents}>
                      {day.entries.slice(0, 3).map(entry => (
                        <Link
                          key={entry.id}
                          href={entry.kind === "task"
                            ? `/production/${entry.productionId}/tasks/${entry.id.slice(5)}`
                            : entry.eventId ? `/production/${entry.productionId}/events/${entry.eventId}/callsheet` : "/my/weekly-call"}
                          className={entry.kind === "call" ? styles.monthEntryCall : styles.monthEntryRelated}
                        >
                          {entry.kind === "call" ? `${fmtTime(entry.startsAt)} ` : ""}{entry.title}
                        </Link>
                      ))}
                      {day.entries.length > 3 && <small>另有 {day.entries.length - 3} 项</small>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "agenda" && (
            <div className={styles.agendaList}>
              {calendarEntries.map(entry => (
                  <Link key={entry.id} href={entry.kind === "task"
                    ? `/production/${entry.productionId}/tasks/${entry.id.slice(5)}`
                    : entry.eventId ? `/production/${entry.productionId}/events/${entry.eventId}/callsheet` : "/my/weekly-call"} className={`${styles.agendaItem} ${entry.kind === "call" ? styles.agendaItemCall : ""}`}>
                    <time><b>{fmtDate(entry.startsAt)}</b><span>{fmtDow(entry.startsAt)} · {fmtTime(entry.startsAt)}</span></time>
                    <span><b>{entry.title}</b><small>{entry.kind === "call" ? "Call" : entry.kind === "event" ? "参与事件" : entry.kind === "task" ? "我的任务" : "我的流程"} · {entry.productionName}{entry.location ? ` · ${entry.location}` : ""}{entry.notes ? ` · ${entry.notes}` : ""}</small></span>
                  </Link>
                ))}
            </div>
          )}

          {(view === "week" ? events.length === 0 : calendarEntries.length === 0) ? (
            <div className={styles.emptyState}>{view === "week" ? "当前周期暂无 Call 安排" : "当前周期暂无与你相关的日程"}<small>你仍可使用上方按钮切换周、月或日程表视图</small></div>
          ) : view === "week" ? (
            <div className={styles.eventCardGrid}>
              {events.map(event => (
                <div key={event.eventId} className={styles.eventBlock}>
                  <div className={styles.eventBlockHeader}>
                    <p className={styles.eventProd}>{event.productionName}</p>
                    <p className={styles.eventTitle}><Link href={`/production/${event.productionId}/events/${event.eventId}/callsheet`} style={{ color: "inherit", textDecoration: "none" }}>{event.eventTitle} →</Link></p>
                    {event.eventLocation && <p className={styles.eventLocation}>📍 {event.eventLocation}</p>}
                    <div className={styles.callBadgeRow}>
                      {event.calls.map(call => <span key={call.callAt} className={styles.callBadge}>{fmtTime(call.callAt)}<small>{fmtDow(call.callAt)}{call.notes ? ` · ${call.notes}` : ""}</small></span>)}
                    </div>
                  </div>
                  {event.schedItems.length > 0 && <div className={styles.eventBlockBody}>{event.schedItems.map((item, index) => <div key={index} className={styles.schedItem}><span className={styles.schedTime}>{item.startTime ? fmtTime(item.startTime) : "—"}</span><span className={styles.schedName}>{item.title}</span></div>)}</div>}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
