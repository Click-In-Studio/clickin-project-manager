"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";
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
const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-500",
  published: "bg-blue-50 text-blue-600",
  completed: "bg-green-50 text-green-600",
  cancelled: "bg-red-50 text-red-400",
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

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        {/* Nav */}
        <div className="flex items-center justify-between mb-5">
          <Link href={`/production/${productionId}/events`} className="text-xs text-zinc-400 hover:text-zinc-600">
            ← Events
          </Link>
          <div className="flex items-center gap-3">
            {canViewReqs && (
              <Link href={`/production/${productionId}/events/${eventId}/reqs`}
                className="text-xs text-zinc-400 hover:text-zinc-600">
                技术需求 →
              </Link>
            )}
            {canViewFull && (
              <Link href={`/production/${productionId}/events/${eventId}`}
                className="text-xs text-zinc-400 hover:text-zinc-600">
                编辑视角 →
              </Link>
            )}
          </div>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h1 className="text-xl font-bold text-zinc-800 leading-tight">{event.title}</h1>
            <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
              <span>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
              {event.startTime && <span>{fmt(event.startTime)}</span>}
              {event.location && <span>· {event.location}</span>}
            </div>
            {event.description && (
              <SmartText content={event.description} plugins={[scriptRefTextPlugin]} className="text-xs text-zinc-500 mt-2" />
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {selfRole === "participant" ? (
              <span className="text-[11px] text-zinc-400">已参与</span>
            ) : (
              <button
                onClick={toggleFollow}
                disabled={followBusy}
                className={`text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 ${
                  selfRole === "follower"
                    ? "bg-blue-50 text-blue-500 hover:bg-blue-100"
                    : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                }`}
              >
                {selfRole === "follower" ? "已关注" : "关注"}
              </button>
            )}
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[event.status] ?? "bg-zinc-100 text-zinc-400"}`}>
              {STATUS_LABELS[event.status] ?? event.status}
            </span>
          </div>
        </div>

        {/* Schedule */}
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase">事件流程</h2>
            {departments.length > 0 && sortedItems.length > 0 && (
              <div className="flex gap-1">
                <button onClick={() => setViewMode("list")}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${viewMode === "list" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-700"}`}>
                  流程
                </button>
                <button onClick={() => setViewMode("table")}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${viewMode === "table" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-700"}`}>
                  表格
                </button>
              </div>
            )}
          </div>

          {sortedItems.length === 0 ? (
            <p className="text-xs text-zinc-300 py-4 text-center">暂无流程</p>
          ) : viewMode === "table" ? (
            <FollowerScheduleTableView items={scheduleItems} departments={departments} />
          ) : (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden divide-y divide-zinc-50">
              {sortedItems.map(item => (
                <div key={item.id} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-800">{item.title}</span>
                        {item.itemType !== "custom" && (
                          <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">
                            {ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
                          </span>
                        )}
                      </div>
                      {item.location && (
                        <p className="text-[11px] text-zinc-400 mt-0.5">{item.location}</p>
                      )}
                      {item.notes && (
                        <SmartText content={item.notes} plugins={[scriptRefTextPlugin]} className="text-[11px] text-zinc-400 mt-0.5" />
                      )}
                    </div>
                    {(item.startTime || item.endTime) && (
                      <div className="shrink-0 text-right text-xs text-zinc-500 font-mono">
                        {fmtTime(item.startTime)}
                        {item.endTime && (
                          <span className="text-zinc-300"> – {fmtTime(item.endTime)}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Reports */}
        {reports.length > 0 && (
          <section>
            <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-3">报告</h2>
            <div className="flex flex-col gap-2">
              {reports.map(report => (
                <Link
                  key={report.id}
                  href={`/production/${productionId}/events/${eventId}/reports/${report.id}`}
                  className="bg-white rounded-2xl shadow-sm px-5 py-4 flex items-center justify-between gap-3 hover:bg-zinc-50 transition-colors"
                >
                  <div>
                    <p className="text-sm font-semibold text-zinc-800">{report.title}</p>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {report.publishedAt ? fmtDate(report.publishedAt) : "草稿"}
                    </p>
                  </div>
                  <span className="shrink-0 text-zinc-300 text-sm">›</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
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
            coveredDeptIds.flatMap(id => departments.find(d => d.id === id)?.memberOpenIds ?? [])
          );
          const relevant = showAll ? cell.item.participants : cell.item.participants.filter(p => deptMemberSet!.has(p.openId));
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
                <SmartText content={cell.item.notes} plugins={[scriptRefTextPlugin]} className="opacity-60 w-full mt-0.5 italic" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
