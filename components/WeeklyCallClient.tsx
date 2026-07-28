"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WeeklyCallEvent } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import styles from "@/components/my-pages.module.css";

function fmtDate(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
function fmtTime(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function fmtDow(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return "周" + "日一二三四五六"[d.getUTCDay()];
}
function isoDateCST(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

type ApiResponse = { events: WeeklyCallEvent[]; weekStart: string; weekEnd: string };

export default function WeeklyCallClient({ token }: { token?: string } = {}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = token
      ? `${BASE_PATH}/api/my/weekly-call?t=${encodeURIComponent(token)}`
      : `${BASE_PATH}/api/my/weekly-call`;
    fetch(url)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className={styles.workspace}>
        <div className={styles.pageHeader}>
          <p className={styles.eyebrow}>Platform · 日程</p>
          <h1 className={styles.pageTitle}>本周日程</h1>
        </div>
        <div className={styles.emptyState}>加载中…</div>
      </div>
    );
  }

  const events = data?.events ?? [];
  const weekStart = data?.weekStart ?? "";
  const weekEnd = data?.weekEnd ?? "";

  const todayIso = isoDateCST(new Date().toISOString());

  const byDateKey = new Map<string, WeeklyCallEvent[]>();
  for (const ev of events) {
    const key = isoDateCST(ev.calls[0].callAt);
    if (!byDateKey.has(key)) byDateKey.set(key, []);
    byDateKey.get(key)!.push(ev);
  }

  const weekDays = weekStart
    ? Array.from({ length: 7 }, (_, i) => {
        const cst = new Date(new Date(weekStart).getTime() + i * 86400000 + 8 * 3_600_000);
        const isoDate = isoDateCST(cst.toISOString());
        return {
          dow: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][i],
          date: cst.getUTCDate(),
          isoDate,
          events: byDateKey.get(isoDate) ?? [],
        };
      })
    : [];

  const weekLabel = weekStart && weekEnd
    ? `${fmtDate(weekStart)} – ${fmtDate(new Date(new Date(weekEnd).getTime() - 86400000).toISOString())}`
    : "";

  return (
    <div className={styles.workspace}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>Platform · 日程</p>
        <h1 className={styles.pageTitle}>本周日程</h1>
        {weekLabel && (
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
            {weekLabel} · UTC+8
          </p>
        )}
      </div>

      {weekDays.length > 0 && (
        <div className={styles.weekGridScroll}>
          <div className={styles.weekGrid}>
            {weekDays.map(day => (
              <Link
                key={day.isoDate}
                href={`/my/daily-call?date=${day.isoDate}`}
                className={`${styles.weekDay} ${styles.weekDayLink}`}
              >
                <div className={styles.weekDayLabel}>{day.dow}</div>
                <div className={`${styles.weekDayDate} ${day.isoDate === todayIso ? styles.today : ""}`}>
                  {day.date}
                </div>
                {day.events.map(ev =>
                  ev.calls.map((c, i) => (
                    <span key={i} className={styles.weekCallPill}>
                      {fmtTime(c.callAt)} <small>{ev.eventTitle}</small>
                    </span>
                  ))
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      {events.length === 0 ? (
        <div className={styles.emptyState}>
          本周暂无 Call 安排
          <small>有新的 Call 时会在这里显示</small>
        </div>
      ) : (
        <div className={styles.eventCardGrid}>
          {events.map(ev => (
            <div key={ev.eventId} className={styles.eventBlock}>
              <div className={styles.eventBlockHeader}>
                <p className={styles.eventProd}>{ev.productionName}</p>
                <p className={styles.eventTitle}>
                  <Link
                    href={`/production/${ev.productionId}/events/${ev.eventId}/callsheet`}
                    style={{ color: "inherit", textDecoration: "none" }}
                  >
                    {ev.eventTitle} →
                  </Link>
                </p>
                {ev.eventLocation && (
                  <p className={styles.eventLocation}>📍 {ev.eventLocation}</p>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {ev.calls.map((c, i) => (
                    <span key={i} className={styles.callBadge}>
                      {fmtTime(c.callAt)}
                      <small>{fmtDow(c.callAt)}{c.notes ? ` · ${c.notes}` : ""}</small>
                    </span>
                  ))}
                </div>
              </div>

              {ev.schedItems.length > 0 && (
                <div className={styles.eventBlockBody}>
                  {ev.schedItems.map((s, i) => (
                    <div key={i} className={styles.schedItem}>
                      <span className={styles.schedTime}>
                        {s.startTime ? fmtTime(s.startTime) : "—"}
                      </span>
                      <span className={styles.schedName}>{s.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
