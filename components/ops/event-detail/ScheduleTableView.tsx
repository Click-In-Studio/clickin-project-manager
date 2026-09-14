"use client";

import { useState, useMemo } from "react";
import SmartText from "@/components/ui/SmartText";
import type { MemberWithRoles } from "@/lib/db";
import type { EventScheduleItemWithParticipants, EventTechReq, EventDepartment } from "@/lib/ops/event-db";
import { fmtTime } from "@/lib/tz";
import ScheduleItemModal, { type ModalState } from "./ScheduleItemModal";

function gcdNum(a: number, b: number): number { return b === 0 ? a : gcdNum(b, a % b); }

function computeBlockMinutes(items: EventScheduleItemWithParticipants[]): number {
  const durations: number[] = [];
  for (const item of items) {
    if (item.startTime && item.endTime) {
      const d = (new Date(item.endTime).getTime() - new Date(item.startTime).getTime()) / 60000;
      if (d > 0) durations.push(d);
    }
  }
  if (durations.length === 0) return 30;
  const g = durations.reduce(gcdNum);
  const niceIntervals = [5, 10, 15, 20, 30, 60];
  return niceIntervals.find(n => n >= g) ?? 60;
}

export default function ScheduleTableView({
  eventId, productionId, items, onItemsChange, canEdit, canAssignPeople,
  members, departments, singleDay, eventDate, eventStart, eventEnd, onTechReqsCreated, versionId,
}: {
  eventId: string; productionId: string;
  items: EventScheduleItemWithParticipants[];
  onItemsChange: (items: EventScheduleItemWithParticipants[]) => void;
  canEdit: boolean; canAssignPeople: boolean;
  members: MemberWithRoles[];
  departments: EventDepartment[];
  singleDay: boolean; eventDate: string;
  eventStart: string | null; eventEnd: string | null;
  onTechReqsCreated?: (reqs: EventTechReq[]) => void;
  versionId: string | null;
}) {
  const [modal, setModal] = useState<ModalState | null>(null);

  const timedItems = useMemo(
    () => items.filter(i => i.startTime && i.endTime).sort(
      (a, b) => new Date(a.startTime!).getTime() - new Date(b.startTime!).getTime()
    ),
    [items]
  );

  const blockMinutes = useMemo(() => computeBlockMinutes(timedItems), [timedItems]);

  const { startMs, endMs, totalBlocks } = useMemo(() => {
    if (timedItems.length === 0) return { startMs: 0, endMs: 0, totalBlocks: 0 };
    const s = Math.min(...timedItems.map(i => new Date(i.startTime!).getTime()));
    const e = Math.max(...timedItems.map(i => new Date(i.endTime!).getTime()));
    const blockMs = blockMinutes * 60000;
    const startSnapped = Math.floor(s / blockMs) * blockMs;
    const endSnapped = Math.ceil(e / blockMs) * blockMs;
    return {
      startMs: startSnapped,
      endMs: endSnapped,
      totalBlocks: Math.round((endSnapped - startSnapped) / blockMs),
    };
  }, [timedItems, blockMinutes]);

  // columns: only departments actually used + "其他" for no-dept / unknown-dept non-break items
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

  function timeToRow(ms: number): number {
    return Math.round((ms - startMs) / (blockMinutes * 60000)) + 1;
  }

  function itemSpansContiguousCols(item: EventScheduleItemWithParticipants): { colStart: number; colSpan: number } | null {
    if (item.departmentIds.length === 0) return null;
    const colIndices = item.departmentIds
      .map(id => cols.findIndex(c => c.id === id))
      .filter(i => i >= 0)
      .sort((a, b) => a - b);
    if (colIndices.length === 0) return null;
    const min = colIndices[0];
    const max = colIndices[colIndices.length - 1];
    // check contiguous
    for (let i = min; i <= max; i++) {
      if (!colIndices.includes(i)) return null;
    }
    return { colStart: min + 2, colSpan: max - min + 1 }; // +2 because col 1 is time label
  }

  if (timedItems.length === 0) {
    return (
      <div className="text-sm text-zinc-400 text-center py-10">
        暂无带时间的流程项
        {canEdit && (
          <button onClick={() => setModal({ mode: "new", startTime: null, deptId: null })}
            className="block mx-auto mt-3 text-zinc-500 hover:text-zinc-700 underline">
            + 添加流程项
          </button>
        )}
      </div>
    );
  }

  const blockMs = blockMinutes * 60000;
  // Show a label every LABEL_EVERY blocks; always show first and last
  const LABEL_EVERY = blockMinutes <= 20 ? 2 : 1;
  const labelledBlocks = new Set<number>();
  for (let b = 0; b <= totalBlocks; b++) {
    if (b === 0 || b === totalBlocks || b % LABEL_EVERY === 0) labelledBlocks.add(b);
  }
  // grid row = b + 2 (row 1 is header); tail goes to totalBlocks + 2 (implicit row) to avoid collision
  const timeLabels = Array.from(labelledBlocks).map(b => ({
    b,
    row: b < totalBlocks ? b + 2 : totalBlocks + 2,
    label: fmtTime(new Date(startMs + b * blockMs).toISOString()),
  }));

  // Rotating palette — each dept column gets a distinct color
  const DEPT_PALETTE = [
    "bg-blue-500   hover:bg-blue-600   text-white",
    "bg-violet-500 hover:bg-violet-600 text-white",
    "bg-teal-500   hover:bg-teal-600   text-white",
    "bg-rose-400   hover:bg-rose-500   text-white",
    "bg-amber-500  hover:bg-amber-600  text-white",
    "bg-indigo-500 hover:bg-indigo-600 text-white",
    "bg-emerald-500 hover:bg-emerald-600 text-white",
    "bg-orange-400 hover:bg-orange-500 text-white",
  ];
  // Map deptId → palette class; "__other__" and no-dept → slate neutral
  const deptColorMap = new Map<string, string>();
  cols.forEach((col, i) => {
    if (!col.isOther) deptColorMap.set(col.id, DEPT_PALETTE[i % DEPT_PALETTE.length]);
  });

  // render cells
  type Cell = {
    item: EventScheduleItemWithParticipants;
    rowStart: number; rowSpan: number;
    colStart: number; colSpan: number;
    isBreak: boolean;
  };

  // Pass 1: all non-break cells
  const nonBreakCells: Cell[] = [];
  for (const item of timedItems) {
    if (item.itemType === "break") continue;
    const rowStart = timeToRow(new Date(item.startTime!).getTime());
    const rowSpan = Math.max(1, timeToRow(new Date(item.endTime!).getTime()) - rowStart);
    if (item.departmentIds.length === 0) {
      const otherIdx = cols.findIndex(c => c.isOther);
      nonBreakCells.push(otherIdx >= 0
        ? { item, rowStart, rowSpan, colStart: otherIdx + 2, colSpan: 1, isBreak: false }
        : { item, rowStart, rowSpan, colStart: 2, colSpan: numDataCols, isBreak: false });
    } else {
      const contiguous = itemSpansContiguousCols(item);
      if (contiguous) {
        nonBreakCells.push({ item, rowStart, rowSpan, ...contiguous, isBreak: false });
      } else {
        for (const deptId of item.departmentIds) {
          const colIdx = cols.findIndex(c => c.id === deptId);
          if (colIdx >= 0) nonBreakCells.push({ item, rowStart, rowSpan, colStart: colIdx + 2, colSpan: 1, isBreak: false });
        }
      }
    }
  }

  // Pass 2: break items
  const breakCells: Cell[] = [];
  for (const item of timedItems) {
    if (item.itemType !== "break") continue;
    const rowStart = timeToRow(new Date(item.startTime!).getTime());
    const rowSpan = Math.max(1, timeToRow(new Date(item.endTime!).getTime()) - rowStart);

    if (item.departmentIds.length > 0) {
      // Has departments: constrain to those columns, same as regular items
      const contiguous = itemSpansContiguousCols(item);
      if (contiguous) {
        breakCells.push({ item, rowStart, rowSpan, ...contiguous, isBreak: true });
      } else {
        for (const deptId of item.departmentIds) {
          const colIdx = cols.findIndex(c => c.id === deptId);
          if (colIdx >= 0) breakCells.push({ item, rowStart, rowSpan, colStart: colIdx + 2, colSpan: 1, isBreak: true });
        }
      }
    } else {
      // No departments: fill all columns not occupied by non-break items
      const occupied = new Set<number>();
      for (const other of nonBreakCells) {
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

  const cells = [...nonBreakCells, ...breakCells];

  return (
    <>
      <div className="overflow-x-auto">
      <div
        className="relative"
        style={{ display: "grid", gridTemplateColumns: gridCols, gridTemplateRows: `auto repeat(${totalBlocks}, ${Math.max(24, Math.round(600 / totalBlocks))}px)`, minWidth: gridMinWidth }}
      >
        {/* header row */}
        <div style={{ gridColumn: 1, gridRow: 1 }} className="sticky top-0 bg-white z-10" />
        {cols.map((col, ci) => (
          <div key={col.id} style={{ gridColumn: ci + 2, gridRow: 1 }}
            className="sticky top-0 bg-white z-10 text-center text-xs font-medium text-zinc-500 border-b border-zinc-100 py-1.5 px-1">
            {col.name}
          </div>
        ))}
        {cols.length === 0 && (
          <div style={{ gridColumn: 2, gridRow: 1 }}
            className="sticky top-0 bg-white z-10 text-center text-xs font-medium text-zinc-400 border-b border-zinc-100 py-1.5">
            流程项
          </div>
        )}

        {/* time labels */}
        {timeLabels.map(({ b, row, label }) => (
          <div key={b} style={{ gridColumn: 1, gridRow: row }}
            className="flex items-start justify-end pr-2 text-[10px] text-zinc-400 select-none pointer-events-none">
            {label}
          </div>
        ))}

        {/* grid lines — extend into col 1 at labelled rows for visual alignment */}
        {Array.from({ length: totalBlocks }).map((_, b) => {
          const isLabelled = labelledBlocks.has(b);
          return (
            <div key={b}
              style={{ gridColumn: isLabelled ? `1 / span ${numDataCols + 1}` : `2 / span ${numDataCols}`, gridRow: b + 2 }}
              className={`border-t pointer-events-none ${isLabelled ? "border-zinc-200" : "border-zinc-100"}`} />
          );
        })}

        {/* click-to-add cells */}
        {canEdit && Array.from({ length: totalBlocks }).map((_, b) =>
          cols.map((col, ci) => {
            const ms = startMs + b * blockMs;
            return (
              <div key={`${b}-${ci}`}
                style={{ gridColumn: ci + 2, gridRow: b + 2 }}
                className="cursor-pointer hover:bg-blue-50/40 transition-colors"
                onClick={() => setModal({
                  mode: "new",
                  startTime: new Date(ms).toISOString(),
                  deptId: col.isOther ? null : col.id,
                })} />
            );
          })
        )}

        {/* items */}
        {cells.map((cell, idx) => {
          // color: break → neutral; full-width no-dept → slate; single/multi-dept → first covered dept's color
          const firstCoveredDeptId = (() => {
            for (let i = 0; i < cell.colSpan; i++) {
              const colIdx = cell.colStart - 2 + i;
              if (colIdx >= 0 && colIdx < cols.length && !cols[colIdx].isOther) return cols[colIdx].id;
            }
            return null;
          })();
          const colorCls = cell.isBreak
            ? "bg-zinc-100 text-zinc-400"
            : (deptColorMap.get(firstCoveredDeptId ?? "") ?? "bg-slate-500 hover:bg-slate-600 text-white");

          // filter participants to those belonging to covered dept columns
          const coveredDeptIds: string[] = [];
          for (let i = 0; i < cell.colSpan; i++) {
            const colIdx = cell.colStart - 2 + i;
            if (colIdx >= 0 && colIdx < cols.length && !cols[colIdx].isOther) {
              coveredDeptIds.push(cols[colIdx].id);
            }
          }
          const showAllParticipants = coveredDeptIds.length === 0 || coveredDeptIds.length === cols.length;
          const deptMemberSet = showAllParticipants ? null : new Set(
            coveredDeptIds.flatMap(id => departments.find(d => d.id === id)?.memberUserIds ?? [])
          );
          const relevantParticipants = showAllParticipants
            ? cell.item.participants
            : (cell.item.participants.filter(p => deptMemberSet!.has(p.userId)) || cell.item.participants);
          const displayParticipants = relevantParticipants.length > 0 ? relevantParticipants : cell.item.participants;

          return (
            <div key={`${cell.item.id}-${idx}`}
              style={{ gridColumn: `${cell.colStart} / span ${cell.colSpan}`, gridRow: `${cell.rowStart + 1} / span ${cell.rowSpan}` }}
              className={`z-10 m-px rounded overflow-hidden flex flex-col justify-start p-1 text-[11px] leading-tight cursor-pointer select-none transition-colors ${colorCls}${cell.isBreak ? " items-center justify-center" : ""}`}
              onClick={() => canEdit && setModal({ mode: "edit", item: cell.item })}
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
                <span className="opacity-60 w-full mt-0.5 italic"><SmartText content={cell.item.notes} productionId={productionId} /></span>
              )}
            </div>
          );
        })}
      </div>
      </div>

      {canEdit && (
        <button onClick={() => setModal({ mode: "new", startTime: null, deptId: null })}
          className="rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors">
          + 添加流程项
        </button>
      )}

      {modal && (
        <ScheduleItemModal
          state={modal}
          eventId={eventId} productionId={productionId}
          items={items} onItemsChange={onItemsChange}
          canAssignPeople={canAssignPeople}
          members={members} departments={departments}
          singleDay={singleDay} eventDate={eventDate}
          eventStart={eventStart} eventEnd={eventEnd}
          onTechReqsCreated={onTechReqsCreated}
          versionId={versionId}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
