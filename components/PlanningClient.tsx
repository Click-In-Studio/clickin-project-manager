"use client";

/**
 * 计划与日程（v3 原型 planning 三视图）：
 *   ① 项目日历 —— 月历统一展示事件与里程碑（任务待 due 字段后加入）
 *   ② 阶段甘特 —— 事件按类型泳道的时间条（轻版）
 *   ③ 执行日程 —— 按事件的多部门 rundown（后续刀）
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import Badge from "@/components/Badge";
import type { ProductionEvent, EventScheduleItemWithParticipants } from "@/lib/event-db";

type PlanningMilestone = { id: string; name: string; endDate: string };
type PlanningDept = { id: string; name: string };

type Props = {
  productionId: string;
  events: ProductionEvent[];
  milestones: PlanningMilestone[];
  departments: PlanningDept[];
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

// ─── 执行日程（原型 TimetableMock：部门泳道 × 15 分钟格 rundown）──────────────

const ITEM_TONE: Record<string, { bg: string; border: string }> = {
  call:   { bg: "var(--stage-soft)", border: "var(--stage)" },
  run:    { bg: "var(--script-soft)", border: "var(--script)" },
  break:  { bg: "var(--surface-2)", border: "var(--line)" },
  notes:  { bg: "var(--success-soft)", border: "var(--success)" },
  custom: { bg: "#eef0f8", border: "#4a5088" },
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule`)
      .then(r => r.json())
      .then((j: { items?: EventScheduleItemWithParticipants[] }) => {
        if (!cancelled) setItems((j.items ?? []).filter(it => it.startTime && it.endTime));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [productionId, eventId]);

  const event = timedEvents.find(e => e.id === eventId) ?? null;
  const deptName = useMemo(() => new Map(departments.map(d => [d.id, d.name])), [departments]);

  // 泳道 = 当前事件 schedule 涉及的部门（保持 departments 原序）；无部门项跨全泳道
  const lanes = useMemo(() => {
    const used = new Set(items.flatMap(it => it.departmentIds));
    const named = departments.filter(d => used.has(d.id));
    return named.length ? named : [{ id: "__all", name: "全体" }];
  }, [items, departments]);

  // 人员选项：schedule 参与人聚合
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) for (const p of it.participants) m.set(p.userId, p.name);
    return [...m.entries()];
  }, [items]);

  const visibleItems = personFilter === "all"
    ? items
    : items.filter(it => it.participants.some(p => p.userId === personFilter) || it.itemType === "break");

  // 时间轴：15 分钟粒度
  const SLOT = 15;
  const startMin = items.length ? Math.floor(Math.min(...items.map(it => minutesOfIso(it.startTime!))) / SLOT) * SLOT : 0;
  const endMin = items.length ? Math.ceil(Math.max(...items.map(it => minutesOfIso(it.endTime!))) / SLOT) * SLOT : 0;
  const slots = Array.from({ length: Math.max(0, (endMin - startMin) / SLOT) }, (_, i) => startMin + i * SLOT);

  // lane 放置：连续部门合并 span，非连续拆多块；无部门=跨全泳道（原型 gridPlacements）
  function placements(it: EventScheduleItemWithParticipants): { start: number; span: number }[] {
    if (it.departmentIds.length === 0) return [{ start: 2, span: lanes.length }];
    const idx = it.departmentIds
      .map(id => lanes.findIndex(l => l.id === id))
      .filter(i => i >= 0)
      .sort((a, b) => a - b);
    if (!idx.length) return [{ start: 2, span: lanes.length }];
    const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    return contiguous
      ? [{ start: idx[0] + 2, span: idx[idx.length - 1] - idx[0] + 1 }]
      : idx.map(i => ({ start: i + 2, span: 1 }));
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
          </div>
        )}
      </div>

      {/* rundownControls */}
      <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--muted)" }}>
          <span>日期 / 事件</span>
          <select value={eventId} onChange={e => { setEventId(e.target.value); setPersonFilter("all"); }} style={SELECT_STYLE}>
            {timedEvents.map(e => (
              <option key={e.id} value={e.id}>
                {e.startTime ? `${new Date(e.startTime).getMonth() + 1}/${new Date(e.startTime).getDate()} · ` : ""}{e.title}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--muted)" }}>
          <span>查看工作流</span>
          <select value={personFilter} onChange={e => setPersonFilter(e.target.value)} style={SELECT_STYLE}>
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
      ) : items.length === 0 ? (
        <p style={{ margin: 0, padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
          该事件暂无日程条目。在事件详情页添加日程后此处生成执行表。
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `72px repeat(${lanes.length}, minmax(150px, 1fr))`,
            gridTemplateRows: `40px repeat(${slots.length}, 30px)`,
            gap: 2, minWidth: lanes.length * 160 + 80,
          }}>
            <div style={{ gridColumn: 1, gridRow: 1, display: "flex", flexDirection: "column", justifyContent: "center", fontSize: 9, color: "var(--muted)" }}>
              <b style={{ color: "var(--ink)", fontSize: 10 }}>时间</b>
              <small>地点 / 时长</small>
            </div>
            {lanes.map((lane, i) => (
              <div key={lane.id} style={{
                gridColumn: i + 2, gridRow: 1, borderRadius: 8, padding: "6px 10px",
                background: "var(--ink)", color: "#fff", display: "flex", flexDirection: "column", justifyContent: "center",
              }}>
                <b style={{ fontSize: 11 }}>{lane.name}</b>
              </div>
            ))}
            {slots.map((m, i) => (
              <div key={m} style={{ gridColumn: 1, gridRow: i + 2, fontSize: 10, color: "var(--muted)", fontVariantNumeric: "tabular-nums", borderTop: "1px solid var(--line)", paddingTop: 2 }}>
                {m % 30 === 0 ? <b style={{ color: "var(--ink)" }}>{fmtMin(m)}</b> : fmtMin(m)}
              </div>
            ))}
            {visibleItems.flatMap(it => placements(it).map((pl, pi) => {
              const rowStart = Math.max(2, Math.floor((minutesOfIso(it.startTime!) - startMin) / SLOT) + 2);
              const rowSpan = Math.max(1, Math.ceil((minutesOfIso(it.endTime!) - minutesOfIso(it.startTime!)) / SLOT));
              const tone = ITEM_TONE[it.itemType] ?? ITEM_TONE.custom;
              const dur = minutesOfIso(it.endTime!) - minutesOfIso(it.startTime!);
              return (
                <article key={`${it.id}-${pi}`} style={{
                  gridColumn: `${pl.start} / span ${pl.span}`,
                  gridRow: `${rowStart} / span ${rowSpan}`,
                  background: tone.bg, borderLeft: `3px solid ${tone.border}`, borderRadius: 8,
                  padding: "6px 10px", overflow: "hidden", minWidth: 0,
                }}>
                  <b style={{ display: "block", fontSize: 11, color: "var(--ink)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.title}
                  </b>
                  <small style={{ display: "block", fontSize: 9, color: "var(--muted)" }}>
                    {[it.location, `${dur} min`].filter(Boolean).join(" · ")}
                  </small>
                  {it.participants.length > 0 && rowSpan >= 2 && (
                    <p style={{ margin: "3px 0 0", fontSize: 9, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.participants.map(p => p.name).join(" · ")}
                    </p>
                  )}
                </article>
              );
            }))}
          </div>
        </div>
      )}
    </section>
  );
}

const SELECT_STYLE: React.CSSProperties = {
  fontSize: 12, color: "var(--ink)", background: "var(--surface)",
  border: "1px solid var(--line)", borderRadius: 8, padding: "7px 11px", outline: "none",
  minWidth: 200,
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
      {mode === "timetable" && <TimetableView {...props} />}
    </div>
  );
}
