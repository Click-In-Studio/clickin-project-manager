"use client";

/**
 * 计划与日程（v3 原型 planning 三视图）：
 *   ① 项目日历 —— 月历统一展示事件与里程碑（任务待 due 字段后加入）
 *   ② 阶段甘特 —— 事件按类型泳道的时间条（轻版）
 *   ③ 执行日程 —— 按事件的多部门 rundown（后续刀）
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ProductionEvent } from "@/lib/event-db";

type PlanningMilestone = { id: string; name: string; endDate: string };

type Props = {
  productionId: string;
  events: ProductionEvent[];
  milestones: PlanningMilestone[];
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练", reading: "围读", meeting: "会议", performance: "演出",
  technical: "技排", dress: "彩排", other: "其他",
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── 项目日历 ─────────────────────────────────────────────────────────────────

function CalendarView({ productionId, events, milestones }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());  // 0-based
  const [selectedDate, setSelectedDate] = useState<string>(ymd(today));

  const byDate = useMemo(() => {
    const map = new Map<string, { events: ProductionEvent[]; milestones: PlanningMilestone[] }>();
    const entry = (date: string) => {
      if (!map.has(date)) map.set(date, { events: [], milestones: [] });
      return map.get(date)!;
    };
    for (const ev of events) {
      if (!ev.startTime || ev.status === "cancelled") continue;
      entry(ymd(new Date(ev.startTime))).events.push(ev);
    }
    for (const m of milestones) {
      entry(m.endDate.slice(0, 10)).milestones.push(m);
    }
    return map;
  }, [events, milestones]);

  // 周一起始的月网格
  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7;  // 周一=0
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
  const selected = byDate.get(selectedDate);

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => move(-1)} aria-label="上一月" style={NAV_BTN}>‹</button>
          <b style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 18, fontWeight: 500, color: "var(--ink)", minWidth: 120, textAlign: "center" }}>
            {year} 年 {month + 1} 月
          </b>
          <button onClick={() => move(1)} aria-label="下一月" style={NAV_BTN}>›</button>
        </div>
        <button
          onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth()); setSelectedDate(todayStr); }}
          style={{ fontSize: 11, fontWeight: 700, border: "1px solid var(--line)", background: "var(--surface)", borderRadius: 7, padding: "4px 10px", cursor: "pointer", color: "var(--muted)" }}
        >
          今天
        </button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 11, color: "var(--muted)" }}>
          <span><i style={{ ...LEGEND_DOT, background: "var(--stage, #b45309)" }} />事件</span>
          <span><i style={{ ...LEGEND_DOT, background: "var(--ink)" }} />里程碑</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {["一", "二", "三", "四", "五", "六", "日"].map(d => (
          <span key={d} style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textAlign: "center", padding: "4px 0" }}>周{d}</span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((d) => {
          const date = ymd(d);
          const inMonth = d.getMonth() === month;
          const day = byDate.get(date);
          const isToday = date === todayStr;
          const isSelected = date === selectedDate;
          return (
            <div
              key={date}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedDate(date)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedDate(date); } }}
              style={{
                minHeight: 84, borderRadius: 9, padding: "6px 7px", cursor: "pointer",
                border: `1px solid ${isSelected ? "var(--ink)" : isToday ? "var(--stage, var(--ink))" : "var(--line)"}`,
                background: inMonth ? "white" : "var(--paper)",
                opacity: inMonth ? 1 : 0.55,
                display: "flex", flexDirection: "column", gap: 3, overflow: "hidden",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: isToday ? 800 : 600, color: isToday ? "var(--stage, var(--ink))" : "var(--muted)" }}>
                {d.getDate()}
              </span>
              {day?.milestones.map(m => (
                <span key={m.id} title={m.name} style={{ ...CHIP, background: "var(--ink)", color: "#fff" }}>◆ {m.name}</span>
              ))}
              {day?.events.slice(0, 3).map(ev => (
                <Link
                  key={ev.id}
                  href={`/production/${productionId}/events/${ev.id}`}
                  onClick={(e) => e.stopPropagation()}
                  title={`${ev.title}${ev.startTime ? ` · ${hhmm(ev.startTime)}` : ""}`}
                  style={{ ...CHIP, background: "var(--stage-soft, #fef3c7)", color: "var(--ink)", textDecoration: "none", display: "block" }}
                >
                  {ev.startTime && <b style={{ fontWeight: 700, marginRight: 3 }}>{hhmm(ev.startTime)}</b>}
                  {ev.title}
                </Link>
              ))}
              {day && day.events.length > 3 && (
                <span style={{ fontSize: 9, color: "var(--muted)" }}>+{day.events.length - 3} 项</span>
              )}
            </div>
          );
        })}
      </div>

      {/* 选中日面板（原型 mobile day panel 的桌面通用版） */}
      <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
        <p style={{ margin: "0 0 10px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
          {Number(selectedDate.slice(5, 7))} 月 {Number(selectedDate.slice(8))} 日安排
        </p>
        {!selected || (selected.events.length === 0 && selected.milestones.length === 0) ? (
          <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>当天暂无安排。</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {selected.milestones.map(m => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--ink)" }}>
                <span style={{ fontWeight: 700 }}>◆</span><b>{m.name}</b>
                <small style={{ color: "var(--muted)" }}>里程碑</small>
              </div>
            ))}
            {selected.events.map(ev => (
              <Link key={ev.id} href={`/production/${productionId}/events/${ev.id}`} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--ink)", textDecoration: "none" }}>
                <time style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, fontSize: 12 }}>
                  {ev.startTime ? hhmm(ev.startTime) : "--:--"}
                </time>
                <b>{ev.title}</b>
                <small style={{ color: "var(--muted)" }}>
                  {EVENT_TYPE_LABELS[ev.eventType] ?? ev.eventType}{ev.location && ` · ${ev.location}`}
                </small>
                <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: "var(--stage, var(--ink))" }}>→</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const NAV_BTN: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 7, border: "1px solid var(--line)",
  background: "var(--surface)", color: "var(--muted)", cursor: "pointer",
  fontSize: 14, lineHeight: 1,
};
const LEGEND_DOT: React.CSSProperties = {
  display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 5,
};
const CHIP: React.CSSProperties = {
  fontSize: 10, borderRadius: 5, padding: "2px 5px",
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

// ─── 主组件：三视图 tab ────────────────────────────────────────────────────────

export default function PlanningClient(props: Props) {
  const [mode, setMode] = useState<"calendar" | "gantt" | "timetable">("calendar");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {([
          ["calendar", "项目日历", "事件与里程碑"],
          ["gantt", "阶段甘特", "时间条总览"],
          ["timetable", "执行日程", "按事件的部门 rundown"],
        ] as const).map(([id, label, hint]) => (
          <button
            key={id}
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
            style={{
              textAlign: "left", borderRadius: 10, padding: "10px 16px", cursor: "pointer",
              border: `1px solid ${mode === id ? "var(--ink)" : "var(--line)"}`,
              background: mode === id ? "var(--ink)" : "var(--surface)",
            }}
          >
            <b style={{ display: "block", fontSize: 13, color: mode === id ? "#fff" : "var(--ink)" }}>{label}</b>
            <small style={{ fontSize: 10, color: mode === id ? "rgba(255,255,255,.6)" : "var(--muted)" }}>{hint}</small>
          </button>
        ))}
      </div>

      {mode === "calendar" && <CalendarView {...props} />}
      {mode === "gantt" && (
        <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: "48px 22px", textAlign: "center", color: "var(--muted)" }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>阶段甘特建设中</p>
          <p style={{ margin: "6px 0 0", fontSize: 11 }}>事件与里程碑的时间条总览即将上线</p>
        </section>
      )}
      {mode === "timetable" && (
        <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: "48px 22px", textAlign: "center", color: "var(--muted)" }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>执行日程建设中</p>
          <p style={{ margin: "6px 0 0", fontSize: 11 }}>按事件的多部门 rundown 泳道视图即将上线</p>
        </section>
      )}
    </div>
  );
}
