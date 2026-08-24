"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import SmartText from "@/components/SmartText";
import { fmtDateTime, fmtTime as fmtTimeTz, fmtDate } from "@/lib/tz";
import type {
  ProductionEvent,
  EventScheduleItemWithParticipants,
  EventReport,
  EventDepartment,
} from "@/lib/event-db";

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练", performance: "演出", meeting: "会议", custom: "其他",
};
const ITEM_TYPE_LABELS: Record<string, string> = {
  scene_rehearsal: "场景排练", fitting: "服装", sound_check: "音响",
  tech_rehearsal: "技排", meeting: "会议", break: "休息", custom: "其他",
};
const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", published: "已发布", completed: "已完成", cancelled: "已取消",
};
const STATUS_COLORS: Record<string, { background: string; color: string }> = {
  draft:     { background: "var(--paper)",  color: "var(--muted)" },
  published: { background: "#eff6ff",       color: "#2563eb" },
  completed: { background: "#f0fdf4",       color: "#16a34a" },
  cancelled: { background: "#fff1f2",       color: "#e11d48" },
};

function fmt(iso: string | null): string { return fmtDateTime(iso); }
function fmtTime(iso: string | null): string { return fmtTimeTz(iso); }

type Props = {
  productionId: string;
  eventId: string;
  event: ProductionEvent;
  scheduleItems: EventScheduleItemWithParticipants[];
  departments?: EventDepartment[];
  reports: EventReport[];
  isAssignee: boolean;
  selfParticipantRole: "participant" | "follower" | null;
  canViewFull?: boolean;
  canViewReqs?: boolean;
};

export default function EventFollowerClient({
  productionId, eventId, event,
  scheduleItems, departments = [], reports,
  isAssignee, selfParticipantRole, canViewFull, canViewReqs,
}: Props) {
  const [followBusy, setFollowBusy] = useState(false);
  const [selfRole, setSelfRole] = useState(selfParticipantRole);
  const [viewMode, setViewMode] = useState<"list" | "table">("list");

  const sortedItems = [...scheduleItems].sort((a, b) => {
    if (!a.startTime && !b.startTime) return a.orderIndex - b.orderIndex;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  async function toggleFollow() {
    setFollowBusy(true);
    try {
      const method = selfRole === "follower" ? "DELETE" : "POST";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/follow`, { method });
      if (res.ok) {
        const data = await res.json();
        setSelfRole(data.role ?? null);
      }
    } finally {
      setFollowBusy(false);
    }
  }

  const curStatusStyle = STATUS_COLORS[event.status] ?? STATUS_COLORS.draft;

  const navLink: React.CSSProperties = { fontSize: 11, color: "var(--muted)", textDecoration: "none" };
  const rule: React.CSSProperties = { border: "none", borderTop: "1px solid var(--line)", margin: 0 };
  const sectionBar: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase",
    color: "var(--muted)", padding: "10px 0 10px",
  };

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>

      {/* Eyebrow + utility links — outside the page sheet, like other pages */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", margin: 0 }}>
          Schedule
        </p>
        <div style={{ display: "flex", gap: 16 }}>
          {canViewReqs && (
            <Link href={`/production/${productionId}/events/${eventId}/reqs`} style={navLink}>技术需求</Link>
          )}
          {canViewFull && (
            <Link href={`/production/${productionId}/events/${eventId}`} style={navLink}>编辑视角</Link>
          )}
        </div>
      </div>

      {/* Page sheet — one white container, everything inside */}
      <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: 12, padding: "24px 28px" }}>

      {/* Document title block */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", margin: 0, lineHeight: 1.2 }}>
            {event.title}
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingTop: 4 }}>
          {selfRole === "participant" ? (
            <span style={{ fontSize: 11, color: "var(--muted)", padding: "3px 8px" }}>已参与</span>
          ) : (
            <button
              onClick={toggleFollow}
              disabled={followBusy}
              style={{
                fontSize: 11, padding: "3px 8px", borderRadius: 6, border: 0, cursor: "pointer",
                opacity: followBusy ? 0.5 : 1, transition: "all .1s",
                background: selfRole === "follower" ? "#eff6ff" : "var(--paper)",
                color: selfRole === "follower" ? "#2563eb" : "var(--muted)",
              }}
            >
              {selfRole === "follower" ? "已关注" : "关注"}
            </button>
          )}
          <span style={{ borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, ...curStatusStyle }}>
            {STATUS_LABELS[event.status] ?? event.status}
          </span>
        </div>
      </div>

      {/* ── Meta + description — same paper plane, no card ── */}
      <hr style={rule} />
      <div style={{ padding: "14px 0" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 16px", marginBottom: event.description ? 10 : 0 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
          {event.startTime && <span style={{ fontSize: 12, color: "var(--muted)" }}>{fmt(event.startTime)}</span>}
          {event.location && <span style={{ fontSize: 12, color: "var(--muted)" }}>{event.location}</span>}
        </div>
        {event.description && (
          <SmartText content={event.description} className="text-xs text-zinc-500" productionId={productionId} />
        )}
      </div>

      {/* ── Schedule section ── */}
      <hr style={rule} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={sectionBar}>事件流程</p>
        {departments.length > 0 && sortedItems.length > 0 && (
          <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {(["list", "table"] as const).map(v => (
              <button key={v} onClick={() => setViewMode(v)} style={{
                padding: "3px 10px", fontSize: 11, fontWeight: 600, border: 0, cursor: "pointer",
                background: viewMode === v ? "var(--ink)" : "transparent",
                color: viewMode === v ? "#fff" : "var(--muted)",
              }}>
                {v === "list" ? "流程" : "表格"}
              </button>
            ))}
          </div>
        )}
      </div>
      <hr style={rule} />

      {sortedItems.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--muted)", padding: "20px 0", textAlign: "center" }}>暂无流程</p>
      ) : viewMode === "table" ? (
        <div style={{ paddingTop: 12 }}>
          <FollowerScheduleTableView items={scheduleItems} departments={departments} />
        </div>
      ) : (
        <div>
          {sortedItems.map((item, i) => (
            <div key={item.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{item.title}</span>
                    {item.itemType !== "custom" && (
                      <span style={{ flexShrink: 0, borderRadius: 4, background: "var(--line)", padding: "1px 6px", fontSize: 10, color: "var(--muted)", opacity: 0.8 }}>
                        {ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
                      </span>
                    )}
                  </div>
                  {item.location && (
                    <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{item.location}</p>
                  )}
                  {item.notes && (
                    <SmartText content={item.notes} className="text-[11px] text-zinc-400 mt-0.5" productionId={productionId} />
                  )}
                </div>
                {(item.startTime || item.endTime) && (
                  <div style={{ flexShrink: 0, textAlign: "right", fontSize: 12, color: "var(--muted)", fontFamily: "monospace" }}>
                    {fmtTime(item.startTime)}
                    {item.endTime && <span style={{ color: "var(--line)" }}> – {fmtTime(item.endTime)}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Reports: appendices ── */}
      {reports.length > 0 && (
        <>
          <div style={{ marginTop: 28 }}>
            <hr style={rule} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <p style={sectionBar}>附件报告</p>
              <span style={{ fontSize: 11, color: "var(--muted)", opacity: 0.6 }}>{reports.length}</span>
            </div>
            <hr style={rule} />
          </div>
          <div>
            {reports.map((report, i) => (
              <Link
                key={report.id}
                href={`/production/${productionId}/reports/${report.id}`}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--line)", textDecoration: "none" }}
              >
                <span style={{ flexShrink: 0, fontSize: 11, color: "var(--line)", fontFamily: "monospace", minWidth: 22 }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{report.title}</span>
                <span style={{ flexShrink: 0, fontSize: 11, color: "var(--muted)" }}>
                  {report.publishedAt ? fmtDate(report.publishedAt) : "草稿"}
                </span>
                <span style={{ flexShrink: 0, color: "var(--muted)", fontSize: 14, marginLeft: 4 }}>›</span>
              </Link>
            ))}
          </div>
        </>
      )}

      </div>{/* end page sheet */}
    </div>
  );
}

// ─── Read-only table view ──────────────────────────────────────────────────────

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

function blockMinutesFor(items: EventScheduleItemWithParticipants[]): number {
  const durations: number[] = [];
  for (const item of items) {
    if (item.startTime && item.endTime) {
      const d = (new Date(item.endTime).getTime() - new Date(item.startTime).getTime()) / 60000;
      if (d > 0) durations.push(d);
    }
  }
  if (durations.length === 0) return 30;
  const g = durations.reduce(gcd);
  return [5, 10, 15, 20, 30, 60].find(n => n >= g) ?? 60;
}

const DEPT_PALETTE = [
  "bg-blue-500 text-white",
  "bg-violet-500 text-white",
  "bg-teal-500 text-white",
  "bg-rose-400 text-white",
  "bg-amber-500 text-white",
  "bg-indigo-500 text-white",
  "bg-emerald-500 text-white",
  "bg-orange-400 text-white",
];

function FollowerScheduleTableView({
  items, departments,
}: {
  items: EventScheduleItemWithParticipants[];
  departments: EventDepartment[];
}) {
  const timedItems = useMemo(
    () => items.filter(i => i.startTime && i.endTime).sort(
      (a, b) => new Date(a.startTime!).getTime() - new Date(b.startTime!).getTime()
    ),
    [items]
  );

  const blockMinutes = useMemo(() => blockMinutesFor(timedItems), [timedItems]);

  const { startMs, endMs: _endMs, totalBlocks } = useMemo(() => {
    if (timedItems.length === 0) return { startMs: 0, endMs: 0, totalBlocks: 0 };
    const s = Math.min(...timedItems.map(i => new Date(i.startTime!).getTime()));
    const e = Math.max(...timedItems.map(i => new Date(i.endTime!).getTime()));
    const bms = blockMinutes * 60000;
    const startSnapped = Math.floor(s / bms) * bms;
    const endSnapped = Math.ceil(e / bms) * bms;
    return { startMs: startSnapped, endMs: endSnapped, totalBlocks: Math.round((endSnapped - startSnapped) / bms) };
  }, [timedItems, blockMinutes]);

  const cols = useMemo(() => {
    const usedDeptIds = new Set<string>();
    let hasNoDeptNonBreak = false;
    for (const item of timedItems) {
      item.departmentIds.forEach(id => usedDeptIds.add(id));
      if (item.itemType !== "break" && item.departmentIds.length === 0) hasNoDeptNonBreak = true;
    }
    const hasExternalDepts = timedItems.some(i =>
      i.itemType !== "break" && i.departmentIds.length > 0 &&
      i.departmentIds.some(id => !departments.find(d => d.id === id))
    );
    const deptCols = departments
      .filter(d => usedDeptIds.has(d.id))
      .map(d => ({ id: d.id, name: d.name, isOther: false }));
    return (hasNoDeptNonBreak || hasExternalDepts)
      ? [...deptCols, { id: "__other__", name: "其他", isOther: true }]
      : deptCols;
  }, [timedItems, departments]);

  const numDataCols = cols.length || 1;
  const MIN_COL_PX = 100;
  const gridCols = `60px repeat(${numDataCols}, minmax(${MIN_COL_PX}px, 1fr))`;
  const gridMinWidth = 60 + numDataCols * MIN_COL_PX;
  const blockMs = blockMinutes * 60000;

  const deptColorMap = useMemo(() => {
    const map = new Map<string, string>();
    cols.forEach((col, i) => { if (!col.isOther) map.set(col.id, DEPT_PALETTE[i % DEPT_PALETTE.length]); });
    return map;
  }, [cols]);

  function timeToRow(ms: number) { return Math.round((ms - startMs) / blockMs) + 1; }

  function contiguousCols(item: EventScheduleItemWithParticipants) {
    if (item.departmentIds.length === 0) return null;
    const idxs = item.departmentIds.map(id => cols.findIndex(c => c.id === id)).filter(i => i >= 0).sort((a, b) => a - b);
    if (idxs.length === 0) return null;
    for (let i = idxs[0]; i <= idxs[idxs.length - 1]; i++) if (!idxs.includes(i)) return null;
    return { colStart: idxs[0] + 2, colSpan: idxs[idxs.length - 1] - idxs[0] + 1 };
  }

  type Cell = { item: EventScheduleItemWithParticipants; rowStart: number; rowSpan: number; colStart: number; colSpan: number; isBreak: boolean };

  const { cells, labelledBlocks } = useMemo(() => {
    const LABEL_EVERY = blockMinutes <= 20 ? 2 : 1;
    const labelled = new Set<number>();
    for (let b = 0; b <= totalBlocks; b++) {
      if (b === 0 || b === totalBlocks || b % LABEL_EVERY === 0) labelled.add(b);
    }

    const nonBreak: Cell[] = [];
    for (const item of timedItems) {
      if (item.itemType === "break") continue;
      const rowStart = timeToRow(new Date(item.startTime!).getTime());
      const rowSpan = Math.max(1, timeToRow(new Date(item.endTime!).getTime()) - rowStart);
      if (item.departmentIds.length === 0) {
        const otherIdx = cols.findIndex(c => c.isOther);
        nonBreak.push(otherIdx >= 0
          ? { item, rowStart, rowSpan, colStart: otherIdx + 2, colSpan: 1, isBreak: false }
          : { item, rowStart, rowSpan, colStart: 2, colSpan: numDataCols, isBreak: false });
      } else {
        const c = contiguousCols(item);
        if (c) {
          nonBreak.push({ item, rowStart, rowSpan, ...c, isBreak: false });
        } else {
          for (const deptId of item.departmentIds) {
            const ci = cols.findIndex(c => c.id === deptId);
            if (ci >= 0) nonBreak.push({ item, rowStart, rowSpan, colStart: ci + 2, colSpan: 1, isBreak: false });
          }
        }
      }
    }

    const breakCells: Cell[] = [];
    for (const item of timedItems) {
      if (item.itemType !== "break") continue;
      const rowStart = timeToRow(new Date(item.startTime!).getTime());
      const rowSpan = Math.max(1, timeToRow(new Date(item.endTime!).getTime()) - rowStart);
      if (item.departmentIds.length > 0) {
        const c = contiguousCols(item);
        if (c) {
          breakCells.push({ item, rowStart, rowSpan, ...c, isBreak: true });
        } else {
          for (const deptId of item.departmentIds) {
            const ci = cols.findIndex(col => col.id === deptId);
            if (ci >= 0) breakCells.push({ item, rowStart, rowSpan, colStart: ci + 2, colSpan: 1, isBreak: true });
          }
        }
      } else {
        const occupied = new Set<number>();
        for (const other of nonBreak) {
          if (rowStart < other.rowStart + other.rowSpan && rowStart + rowSpan > other.rowStart) {
            for (let ci = other.colStart - 2; ci < other.colStart - 2 + other.colSpan; ci++) occupied.add(ci);
          }
        }
        let runStart: number | null = null;
        for (let ci = 0; ci <= numDataCols; ci++) {
          const free = ci < numDataCols && !occupied.has(ci);
          if (free && runStart === null) { runStart = ci; }
          else if (!free && runStart !== null) {
            breakCells.push({ item, rowStart, rowSpan, colStart: runStart + 2, colSpan: ci - runStart, isBreak: true });
            runStart = null;
          }
        }
      }
    }

    return { cells: [...nonBreak, ...breakCells], labelledBlocks: labelled };
  }, [timedItems, cols, numDataCols, blockMinutes, totalBlocks, startMs, blockMs]);

  if (timedItems.length === 0) {
    return <p className="text-xs text-zinc-300 py-4 text-center">暂无带时间的流程项</p>;
  }

  const LABEL_EVERY = blockMinutes <= 20 ? 2 : 1;
  const timeLabels = Array.from(labelledBlocks).map(b => ({
    b,
    row: b < totalBlocks ? b + 2 : totalBlocks + 2,
    label: fmtTime(new Date(startMs + b * blockMs).toISOString()),
  }));

  const rowHeight = Math.max(24, Math.round(600 / totalBlocks));

  return (
    <div className="overflow-x-auto">
      <div
        className="relative"
        style={{ display: "grid", gridTemplateColumns: gridCols, gridTemplateRows: `auto repeat(${totalBlocks}, ${rowHeight}px)`, minWidth: gridMinWidth }}
      >
        {/* header */}
        <div style={{ gridColumn: 1, gridRow: 1 }} />
        {cols.map((col, ci) => (
          <div key={col.id} style={{ gridColumn: ci + 2, gridRow: 1 }}
            className="text-center text-xs font-medium text-zinc-500 border-b border-zinc-100 py-1.5 px-1">
            {col.name}
          </div>
        ))}

        {/* time labels */}
        {timeLabels.map(({ b, row, label }) => (
          <div key={b} style={{ gridColumn: 1, gridRow: row }}
            className="flex items-start justify-end pr-2 text-[10px] text-zinc-400 select-none pointer-events-none">
            {label}
          </div>
        ))}

        {/* grid lines */}
        {Array.from({ length: totalBlocks }).map((_, b) => {
          const isLabelled = labelledBlocks.has(b);
          return (
            <div key={b}
              style={{ gridColumn: isLabelled ? `1 / span ${numDataCols + 1}` : `2 / span ${numDataCols}`, gridRow: b + 2 }}
              className={`border-t pointer-events-none ${isLabelled ? "border-zinc-200" : "border-zinc-100"}`} />
          );
        })}

        {/* cells */}
        {cells.map((cell, idx) => {
          const firstDeptId = (() => {
            for (let i = 0; i < cell.colSpan; i++) {
              const ci = cell.colStart - 2 + i;
              if (ci >= 0 && ci < cols.length && !cols[ci].isOther) return cols[ci].id;
            }
            return null;
          })();
          const colorCls = cell.isBreak
            ? "bg-zinc-100 text-zinc-400"
            : (deptColorMap.get(firstDeptId ?? "") ?? "bg-slate-500 text-white");

          const coveredDeptIds: string[] = [];
          for (let i = 0; i < cell.colSpan; i++) {
            const ci = cell.colStart - 2 + i;
            if (ci >= 0 && ci < cols.length && !cols[ci].isOther) coveredDeptIds.push(cols[ci].id);
          }
          const showAll = coveredDeptIds.length === 0 || coveredDeptIds.length === cols.length;
          const deptMemberSet = showAll ? null : new Set(
            coveredDeptIds.flatMap(id => departments.find(d => d.id === id)?.memberUserIds ?? [])
          );
          const relevant = showAll ? cell.item.participants : cell.item.participants.filter(p => deptMemberSet!.has(p.userId));
          const displayParticipants = relevant.length > 0 ? relevant : cell.item.participants;

          return (
            <div key={`${cell.item.id}-${idx}`}
              style={{ gridColumn: `${cell.colStart} / span ${cell.colSpan}`, gridRow: `${cell.rowStart + 1} / span ${cell.rowSpan}` }}
              className={`z-10 m-px rounded overflow-hidden flex flex-col justify-start p-1 text-[11px] leading-tight select-none ${colorCls}${cell.isBreak ? " items-center justify-center" : ""}`}
            >
              <span className="font-medium truncate w-full">{cell.item.title}</span>
              {!cell.isBreak && cell.item.location && (
                <span className="opacity-70 truncate w-full">{cell.item.location}</span>
              )}
              {!cell.isBreak && displayParticipants.length > 0 && (
                <span className="opacity-80 truncate w-full mt-0.5">
                  {displayParticipants.map(p => p.name).join("、")}
                </span>
              )}
              {!cell.isBreak && cell.item.notes && (
                <SmartText content={cell.item.notes} className="opacity-60 w-full mt-0.5 italic" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
