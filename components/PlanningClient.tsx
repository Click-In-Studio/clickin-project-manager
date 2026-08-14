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
            月历统一展示事件与里程碑；点击条目直接打开。
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
              {day?.events.slice(0, 3).map(ev => (
                <Link
                  key={ev.id}
                  href={`/production/${productionId}/events/${ev.id}`}
                  title={`${ev.title}${ev.startTime ? ` · ${hhmm(ev.startTime)}` : ""}`}
                  style={{ ...CAL_CHIP, background: "var(--script-soft)", color: "var(--script)", textDecoration: "none", display: "block" }}
                >
                  事件 · {ev.title}
                </Link>
              ))}
              {day && day.events.length > 3 && (
                <span style={{ fontSize: 8, color: "var(--muted)" }}>+{day.events.length - 3} 项</span>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 9, color: "var(--muted)" }}>
        点击条目直接打开事件；任务上日历待任务日期字段就位。
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
      ) : items.length === 0 ? (
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
            {visibleItems.flatMap(it => placements(it).map((pl, pi) => {
              const rowStart = Math.max(2, Math.floor((minutesOfIso(it.startTime!) - startMin) / SLOT) + 2);
              const rowSpan = Math.max(1, Math.ceil((minutesOfIso(it.endTime!) - minutesOfIso(it.startTime!)) / SLOT));
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
          ["gantt", "阶段甘特", "项目阶段与重要排期"],
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
