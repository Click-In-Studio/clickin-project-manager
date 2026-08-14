"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type React from "react";
import { BASE_PATH } from "@/lib/base-path";
import PageHeader, { PRIMARY_BTN } from "@/components/PageHeader";
import type { ProductionEvent, EventDepartment } from "@/lib/event-db";
import { fmtDateTimeSmart, datetimeLocalToIso, dateTimeToIso } from "@/lib/tz";

// ─── Shared constants ────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练",
  performance: "演出",
  meeting: "会议",
  custom: "其他",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  completed: "已完成",
  cancelled: "已取消",
};

const STATUS_COLORS: Record<string, { background: string; color: string }> = {
  draft:     { background: "var(--paper)",  color: "var(--muted)" },
  published: { background: "#eff6ff",       color: "#2563eb" },
  completed: { background: "#f0fdf4",       color: "#16a34a" },
  cancelled: { background: "#fff1f2",       color: "#e11d48" },
};

// Calendar: chip colors by event type
const TYPE_CHIP: Record<string, { bg: string; fg: string }> = {
  rehearsal:   { bg: "#ddeef0", fg: "#2f6670" },
  performance: { bg: "#f5e6dc", fg: "#a55c32" },
  meeting:     { bg: "#eef0f8", fg: "#4a5088" },
  custom:      { bg: "var(--paper)", fg: "var(--muted)" },
};

const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
const DAY_NAMES   = ["周一","周二","周三","周四","周五","周六","周日"];

// ─── Calendar helpers ────────────────────────────────────────────────────────

interface CalEventSlot {
  event: ProductionEvent;
  colStart: number;          // 0–6 (Mon–Sun) within this week
  colEnd: number;            // 0–6, inclusive
  row: number;               // stacking row (0 = topmost)
  continuesBefore: boolean;  // event started before this week
  continuesAfter: boolean;   // event ends after this week
}

/** Build 2-D array of calendar dates (Monday-first) for the given month. */
function buildWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const last  = new Date(year, month + 1, 0);
  const startOffset = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
  const daysInGrid  = Math.ceil((startOffset + last.getDate()) / 7) * 7;
  const weeks: Date[][] = [];
  for (let i = 0; i < daysInGrid; i += 7) {
    const week: Date[] = [];
    for (let j = 0; j < 7; j++) {
      week.push(new Date(year, month, 1 - startOffset + i + j));
    }
    weeks.push(week);
  }
  return weeks;
}

/** Local-midnight timestamp for a date (for same-day comparison). */
function dayTs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Return the [start, end] day timestamps for an event, in local time. */
function eventDayRange(event: ProductionEvent): { start: number; end: number } | null {
  if (!event.startTime) return null;
  const s = new Date(event.startTime);
  const start = new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime();
  const end = event.endTime
    ? (() => { const e = new Date(event.endTime!); return new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime(); })()
    : start;
  return { start, end: Math.max(start, end) };
}

/**
 * For a given week, return all CalEventSlots with stacking rows assigned.
 * Uses a greedy interval-scheduling approach to minimise wasted rows.
 */
function computeWeekSlots(week: Date[], events: ProductionEvent[]): CalEventSlot[] {
  const wsTs = dayTs(week[0]);
  const weTs = dayTs(week[6]);
  const DAY_MS = 86_400_000;

  const overlapping: Array<Omit<CalEventSlot, "row">> = [];
  for (const event of events) {
    const range = eventDayRange(event);
    if (!range) continue;
    if (range.end < wsTs || range.start > weTs) continue;
    overlapping.push({
      event,
      colStart: Math.max(0, Math.round((range.start - wsTs) / DAY_MS)),
      colEnd:   Math.min(6, Math.round((range.end   - wsTs) / DAY_MS)),
      continuesBefore: range.start < wsTs,
      continuesAfter:  range.end   > weTs,
    });
  }

  // Sort: earlier start first; on tie, wider span first (gets priority row)
  overlapping.sort((a, b) =>
    a.colStart - b.colStart || (b.colEnd - b.colStart) - (a.colEnd - a.colStart)
  );

  // Greedy row assignment
  const rowEndCols: number[] = [];
  const slots: CalEventSlot[] = [];
  for (const item of overlapping) {
    let r = 0;
    while (r < rowEndCols.length && rowEndCols[r] >= item.colStart) r++;
    if (r >= rowEndCols.length) rowEndCols.push(item.colEnd);
    else rowEndCols[r] = item.colEnd;
    slots.push({ ...item, row: r });
  }
  return slots;
}

// ─── Calendar: week row ──────────────────────────────────────────────────────

const DAY_H    = 26;   // px — date-number header area
const EVT_H    = 22;   // px — height per event row
const MAX_ROWS = 3;    // max visible event rows before overflow
const GAP      = 2;    // px — gap between chip edge and cell border

function CalWeekRow({
  week, month, slots, overflowByCol, productionId, canViewFull, todayTs,
}: {
  week: Date[];
  month: number;
  slots: CalEventSlot[];
  overflowByCol: number[];
  productionId: string;
  canViewFull: boolean;
  todayTs: number;
}) {
  const visibleSlots = slots.filter(s => s.row < MAX_ROWS);
  const maxRow       = visibleSlots.reduce((m, s) => Math.max(m, s.row), -1);
  const hasOverflow  = overflowByCol.some(n => n > 0);
  const evtAreaH     = (maxRow + 1) * EVT_H + (hasOverflow ? 20 : 0) + 4;
  const totalH       = DAY_H + Math.max(evtAreaH, 4);

  return (
    <div style={{
      position: "relative",
      display: "grid",
      gridTemplateColumns: "repeat(7, 1fr)",
      minHeight: totalH,
    }}>
      {/* Date number cells */}
      {week.map((day, col) => {
        const isToday    = dayTs(day) === todayTs;
        const isCurMonth = day.getMonth() === month;
        return (
          <div key={col} style={{
            borderRight: "1px solid var(--line)",
            borderBottom: "1px solid var(--line)",
            padding: 7,
            height: Math.max(totalH, 93),
            boxSizing: "border-box",
            background: isToday ? "#f8f0e7" : undefined,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}>
            <b style={{
              fontSize: 9,
              fontWeight: 700,
              color: isCurMonth ? "var(--muted)" : "var(--line)",
            }}>
              {day.getDate()}
            </b>
          </div>
        );
      })}

      {/* Event bar layer (absolutely positioned below date numbers) */}
      <div style={{ position: "absolute", top: DAY_H, left: 0, right: 0, bottom: 0 }}>
        {visibleSlots.map((s, i) => {
          const chip  = TYPE_CHIP[s.event.eventType] ?? TYPE_CHIP.custom;
          const lPct  = (s.colStart / 7) * 100;
          const wPct  = ((s.colEnd - s.colStart + 1) / 7) * 100;
          const lOff  = s.continuesBefore ? 0 : GAP;
          const rOff  = s.continuesAfter  ? 0 : GAP;
          const href  = canViewFull
            ? `/production/${productionId}/events/${s.event.id}`
            : `/production/${productionId}/events/${s.event.id}/view`;
          return (
            <Link key={i} href={href} style={{
              position: "absolute",
              top: s.row * EVT_H + GAP,
              left: `calc(${lPct}% + ${lOff}px)`,
              width: `calc(${wPct}% - ${lOff + rOff}px)`,
              height: EVT_H - GAP * 2,
              background: chip.bg,
              color: chip.fg,
              borderTopLeftRadius:     s.continuesBefore ? 0 : 4,
              borderBottomLeftRadius:  s.continuesBefore ? 0 : 4,
              borderTopRightRadius:    s.continuesAfter  ? 0 : 4,
              borderBottomRightRadius: s.continuesAfter  ? 0 : 4,
              fontSize: 11,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              paddingLeft:  s.continuesBefore ? 4 : 7,
              paddingRight: s.continuesAfter  ? 2 : 7,
              textDecoration: "none",
              overflow: "hidden",
              whiteSpace: "nowrap",
              lineHeight: 1,
            }}>
              {s.continuesBefore && (
                <span style={{ flexShrink: 0, fontSize: 9, marginRight: 3, opacity: 0.6 }}>◀</span>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.event.title}</span>
              {s.continuesAfter && (
                <span style={{ flexShrink: 0, fontSize: 9, marginLeft: 3, opacity: 0.6 }}>▶</span>
              )}
            </Link>
          );
        })}

        {/* Per-column overflow count */}
        {hasOverflow && overflowByCol.map((n, col) => n > 0 ? (
          <div key={`ov-${col}`} style={{
            position: "absolute",
            bottom: 2,
            left: `${(col / 7) * 100}%`,
            width: `${100 / 7}%`,
            paddingLeft: 8,
            fontSize: 10,
            color: "var(--muted)",
            lineHeight: "18px",
          }}>
            +{n}
          </div>
        ) : null)}
      </div>
    </div>
  );
}

// ─── Calendar view ───────────────────────────────────────────────────────────

function CalendarView({
  events, productionId, canViewFull,
}: {
  events: ProductionEvent[];
  productionId: string;
  canViewFull: boolean;
}) {
  const now = new Date();
  const todayTs = useMemo(() => dayTs(new Date()), []);
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const weeks = useMemo(() => buildWeeks(year, month), [year, month]);

  const weekData = useMemo(() =>
    weeks.map(week => {
      const slots = computeWeekSlots(week, events);
      const overflowByCol = new Array(7).fill(0);
      for (const s of slots) {
        if (s.row >= MAX_ROWS) {
          for (let c = s.colStart; c <= s.colEnd; c++) overflowByCol[c]++;
        }
      }
      return { slots, overflowByCol };
    }),
    [weeks, events]
  );

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }
  function goToday() {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  const navBtn: React.CSSProperties = {
    width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 14, lineHeight: 1, background: "none", border: "1px solid var(--line)",
    borderRadius: 5, cursor: "pointer", color: "var(--ink)", flexShrink: 0,
  };

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      {/* Panel heading */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
            <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
              {year}年{MONTH_NAMES[month]}
            </p>
            <button onClick={prevMonth} style={navBtn}>‹</button>
            <button onClick={nextMonth} style={navBtn}>›</button>
            <button onClick={goToday} style={{
              padding: "2px 8px", fontSize: 9, fontWeight: 700,
              background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 5,
              cursor: "pointer", color: "var(--muted)",
            }}>今天</button>
          </div>
          <h2 style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, margin: "5px 0 0" }}>项目日历</h2>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, color: "var(--muted)", fontSize: 9, alignItems: "center", paddingTop: 4 }}>
          {(["rehearsal", "performance", "meeting"] as const).map(type => {
            const chip = TYPE_CHIP[type];
            const label = type === "rehearsal" ? "排练" : type === "performance" ? "演出" : "会议";
            return (
              <span key={type} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <i style={{ width: 7, height: 7, borderRadius: 2, background: chip.fg, flexShrink: 0, display: "inline-block" }} />
                {label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Day-of-week header */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {DAY_NAMES.map((d, i) => (
          <span key={i} style={{ padding: 7, color: "var(--muted)", fontSize: 9, textAlign: "center", display: "block" }}>
            {d}
          </span>
        ))}
      </div>

      {/* Calendar grid */}
      <div style={{ borderTop: "1px solid var(--line)", borderLeft: "1px solid var(--line)" }}>
        {weeks.map((week, wi) => (
          <CalWeekRow
            key={wi}
            week={week}
            month={month}
            slots={weekData[wi].slots}
            overflowByCol={weekData[wi].overflowByCol}
            productionId={productionId}
            canViewFull={canViewFull}
            todayTs={todayTs}
          />
        ))}
      </div>
    </section>
  );
}

// ─── List view: EventCard ────────────────────────────────────────────────────

function EventCard({
  event, productionId, role, canViewFull, taskCount = 0, onFollow, onUnfollow,
}: {
  event: ProductionEvent;
  productionId: string;
  role: "participant" | "follower" | null;
  canViewFull: boolean;
  taskCount?: number;
  onFollow: (eventId: string) => void;
  onUnfollow: (eventId: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const method = role === "follower" ? "DELETE" : "POST";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/follow`, { method });
      if (res.ok) {
        if (method === "POST") onFollow(event.id);
        else onUnfollow(event.id);
      }
    } finally {
      setBusy(false);
    }
  }

  const statusStyle = STATUS_COLORS[event.status] ?? STATUS_COLORS.draft;
  return (
    <div style={{ position: "relative", background: "white", borderRadius: 12, border: "1px solid var(--line)" }}>
      <Link
        href={canViewFull
          ? `/production/${productionId}/events/${event.id}`
          : `/production/${productionId}/events/${event.id}/view`}
        style={{ display: "block", padding: "14px 16px", paddingRight: 80, textDecoration: "none" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", lineHeight: 1.4, margin: 0 }}>{event.title}</h3>
          <span style={{ flexShrink: 0, borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 600, ...statusStyle }}>
            {STATUS_LABELS[event.status] ?? event.status}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", fontSize: 12, color: "var(--muted)" }}>
          <span style={{ borderRadius: 4, background: "var(--paper)", padding: "1px 6px", fontSize: 11, color: "var(--muted)" }}>
            {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
          </span>
          {event.startTime && <span>{fmtDateTimeSmart(event.startTime)}</span>}
          {event.location && <span>{event.location}</span>}
        </div>
        {/* 关联徽章链（原型 inlineActions）：跨模块直达，无需返回 */}
        {(canViewFull || taskCount > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
            {canViewFull && (
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--stage, var(--ink))" }}>
                执行流程 →
              </span>
            )}
            {taskCount > 0 && (
              <span
                role="link"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `${BASE_PATH}/production/${productionId}/tasks?event=${event.id}`; }}
                style={{ fontSize: 11, fontWeight: 700, color: "var(--stage, var(--ink))", cursor: "pointer" }}
              >
                {taskCount} 个任务 →
              </span>
            )}
          </div>
        )}
      </Link>
      <div style={{ position: "absolute", right: 12, bottom: 12 }}>
        {role === "participant" ? (
          <span style={{ fontSize: 11, color: "var(--muted)", padding: "3px 8px" }}>已参与</span>
        ) : (
          <button
            onClick={toggle}
            disabled={busy}
            style={{
              fontSize: 11, padding: "3px 8px", borderRadius: 6, border: 0, cursor: "pointer",
              opacity: busy ? 0.5 : 1, transition: "all .1s",
              background: role === "follower" ? "#eff6ff" : "var(--paper)",
              color: role === "follower" ? "#2563eb" : "var(--muted)",
            }}
          >
            {role === "follower" ? "已关注" : "关注"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Create event modal ──────────────────────────────────────────────────────

function CreateEventModal({
  productionId, departments, onClose, onCreated,
}: {
  productionId: string;
  departments: EventDepartment[];
  onClose: () => void;
  onCreated: (ev: ProductionEvent) => void;
}) {
  const [title,         setTitle]         = useState("");
  const [eventType,     setEventType]     = useState("rehearsal");
  const [location,      setLocation]      = useState("");
  const [singleDay,     setSingleDay]     = useState(false);
  const [singleDate,    setSingleDate]    = useState("");
  const [startTime,     setStartTime]     = useState("");
  const [endTime,       setEndTime]       = useState("");
  const [description,   setDescription]   = useState("");
  const [notifyDeptIds, setNotifyDeptIds] = useState<string[]>([]);
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("请输入标题"); return; }
    const resolvedStart = singleDay
      ? (singleDate ? dateTimeToIso(singleDate, "00:00") : null)
      : (startTime  ? datetimeLocalToIso(startTime) : null);
    const resolvedEnd = singleDay
      ? (singleDate ? dateTimeToIso(singleDate, "23:59") : null)
      : (endTime    ? datetimeLocalToIso(endTime) : null);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          eventType,
          location: location.trim(),
          startTime: resolvedStart,
          endTime: resolvedEnd,
          description: description.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "创建失败"); return; }
      if (notifyDeptIds.length > 0 && data.event?.id) {
        await fetch(`${BASE_PATH}/api/production/${productionId}/events/${data.event.id}/awaiting-reqs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentIds: notifyDeptIds }),
        });
      }
      onCreated(data.event);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", borderRadius: 8, border: "1px solid var(--line)",
    background: "var(--paper)", padding: "7px 10px", fontSize: 13,
    color: "var(--ink)", outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "block", fontSize: 11, fontWeight: 600,
    color: "var(--muted)", marginBottom: 4, letterSpacing: ".02em",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--surface)", borderRadius: 16, border: "1px solid var(--line)", width: "100%", maxWidth: 440, padding: 24, boxShadow: "0 8px 32px rgba(0,0,0,.12)", maxHeight: "90vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>新建事件</p>
          <button onClick={onClose} style={{ fontSize: 18, color: "var(--muted)", background: "none", border: 0, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>标题 *</label>
            <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} placeholder="事件标题" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>类型</label>
              <select value={eventType} onChange={e => setEventType(e.target.value)} style={inputStyle}>
                <option value="rehearsal">排练</option>
                <option value="performance">演出</option>
                <option value="meeting">会议</option>
                <option value="custom">其他</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>地点</label>
              <input value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} placeholder="排练厅…" />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", fontSize: 12, color: "var(--ink)" }}>
            <input type="checkbox" checked={singleDay} onChange={e => setSingleDay(e.target.checked)} />
            单日事件
          </label>
          {singleDay ? (
            <div>
              <label style={labelStyle}>日期</label>
              <input type="date" value={singleDate} onChange={e => setSingleDate(e.target.value)} style={inputStyle} />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>开始时间</label>
                <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>结束时间</label>
                <input type="datetime-local" value={endTime} onChange={e => setEndTime(e.target.value)} style={inputStyle} />
              </div>
            </div>
          )}
          <div>
            <label style={labelStyle}>备注</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              style={{ ...inputStyle, resize: "none" }} placeholder="可选…" />
          </div>
          {departments.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>通知部门（创建待确认需求）</span>
                <button type="button"
                  onClick={() => setNotifyDeptIds(
                    notifyDeptIds.length === departments.length ? [] : departments.map(d => d.id)
                  )}
                  style={{ fontSize: 11, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}
                >
                  {notifyDeptIds.length === departments.length ? "取消全选" : "全选"}
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {departments.map(d => (
                  <button key={d.id} type="button"
                    onClick={() => setNotifyDeptIds(prev =>
                      prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id]
                    )}
                    style={{
                      borderRadius: 20, padding: "4px 12px", fontSize: 12, border: "1px solid var(--line)",
                      cursor: "pointer", transition: "all .1s",
                      background: notifyDeptIds.includes(d.id) ? "var(--ink)" : "var(--surface)",
                      color: notifyDeptIds.includes(d.id) ? "#fff" : "var(--muted)",
                    }}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p style={{ fontSize: 12, color: "#dc2626" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            <button type="button" onClick={onClose}
              style={{ padding: "7px 16px", fontSize: 13, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}>
              取消
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: "7px 20px", borderRadius: 8, background: "var(--ink)", color: "#fff", fontSize: 13, fontWeight: 600, border: 0, cursor: "pointer", opacity: saving ? 0.5 : 1 }}>
              {saving ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

type Props = {
  productionId: string;
  productionName: string;
  initialEvents: ProductionEvent[];
  canCreate: boolean;
  canViewFull: boolean;
  myParticipations: { eventId: string; role: "participant" | "follower" }[];
  currentUserId: string;
  departments: EventDepartment[];
  taskCounts?: Record<string, number>;
};

export default function EventsClient({
  productionId, productionName, initialEvents, canCreate, canViewFull,
  myParticipations, departments, taskCounts = {},
}: Props) {
  const [events,      setEvents]      = useState(initialEvents);
  const [showCreate,  setShowCreate]  = useState(false);
  const [view,        setView]        = useState<"list" | "calendar">("list");
  const [justCreated, setJustCreated] = useState<ProductionEvent | null>(null);
  const [roles,      setRoles]      = useState<Map<string, "participant" | "follower">>(() =>
    new Map(myParticipations.map(p => [p.eventId, p.role]))
  );

  const now      = new Date();
  const upcoming = events.filter(e => !e.startTime || new Date(e.startTime) >= now);
  const past     = events.filter(e => e.startTime && new Date(e.startTime) < now);

  function handleCreated(ev: ProductionEvent) {
    setEvents(prev => [ev, ...prev].sort((a, b) => {
      if (!a.startTime && !b.startTime) return 0;
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    }));
    setShowCreate(false);
    setJustCreated(ev);
  }

  function handleFollow(eventId: string) {
    setRoles(prev => new Map(prev).set(eventId, "follower"));
  }
  function handleUnfollow(eventId: string) {
    setRoles(prev => { const m = new Map(prev); m.delete(eventId); return m; });
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Page header（v3 统一页头） */}
      <PageHeader
        eyebrow="Schedule"
        title="日程"
        side="stage"
        actions={
          <>
            <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
              {(["list", "calendar"] as const).map(v => (
                <button key={v} onClick={() => setView(v)} style={{
                  padding: "5px 12px", fontSize: 12, fontWeight: 600, border: 0, cursor: "pointer",
                  transition: "all .1s",
                  background: view === v ? "var(--ink)" : "white",
                  color:      view === v ? "#fff"        : "var(--muted)",
                }}>
                  {v === "list" ? "列表" : "日历"}
                </button>
              ))}
            </div>

            {canCreate && (
              <button onClick={() => setShowCreate(true)} style={PRIMARY_BTN}>
                ＋ 新建事件
              </button>
            )}
          </>
        }
      />

      {/* Content */}
      {view === "calendar" ? (
        <CalendarView
          events={events}
          productionId={productionId}
          canViewFull={canViewFull}
        />
      ) : (
        <>
          {/* 三步流程说明条（原型 flowExplainer）：只对可创建者展示 */}
          {canCreate && (
            <section style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12,
              padding: "12px 18px", marginBottom: 18,
            }}>
              {[["1", "定义事件", "类型 · 时间 · 地点 · 人员"],
                ["2", "确认任务", "负责人 · 截止 · 通知对象"],
                ["3", "发布与追踪", "站内通知 · 确认 · 执行"]].map(([n, t, s], i) => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {i > 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>→</span>}
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center",
                    background: "var(--stage, var(--ink))", color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0,
                  }}>{n}</span>
                  <span><b style={{ fontSize: 12, color: "var(--ink)" }}>{t}</b>
                  <small style={{ display: "block", fontSize: 10, color: "var(--muted)" }}>{s}</small></span>
                </div>
              ))}
            </section>
          )}

          {/* 发布成功 banner */}
          {justCreated && (
            <section role="status" style={{
              display: "flex", alignItems: "center", gap: 12,
              background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12,
              padding: "12px 18px", marginBottom: 18,
            }}>
              <span style={{ color: "#16a34a", fontWeight: 700 }}>✓</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 13, color: "var(--ink)" }}>「{justCreated.title}」已创建</b>
                <small style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                  可继续补充日程条目、任务与参与人员。
                </small>
              </div>
              <Link
                href={`/production/${productionId}/events/${justCreated.id}`}
                style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap" }}
              >
                进入事件 →
              </Link>
              <button onClick={() => setJustCreated(null)} style={{ border: 0, background: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14 }}>×</button>
            </section>
          )}

          {events.length === 0 && (
            <p style={{ textAlign: "center", fontSize: 13, color: "var(--muted)", padding: "48px 0" }}>暂无事件</p>
          )}

          {upcoming.length > 0 && (
            <section style={{ marginBottom: 28 }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 12 }}>即将进行</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {upcoming.map(ev => (
                  <EventCard
                    key={ev.id} event={ev} productionId={productionId}
                    role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                    taskCount={taskCounts[ev.id] ?? 0}
                    onFollow={handleFollow} onUnfollow={handleUnfollow}
                  />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 12 }}>已过去</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {past.map(ev => (
                  <EventCard
                    key={ev.id} event={ev} productionId={productionId}
                    role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                    taskCount={taskCounts[ev.id] ?? 0}
                    onFollow={handleFollow} onUnfollow={handleUnfollow}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {showCreate && (
        <CreateEventModal
          productionId={productionId}
          departments={departments}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
