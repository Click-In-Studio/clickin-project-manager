"use client";

import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";
import { fmtDateTime, fmtTime as fmtTimeTz } from "@/lib/tz";
import type {
  ProductionEvent,
  EventScheduleItemWithParticipants,
  EventCallTime,
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

function fmt(iso: string | null): string { return fmtDateTime(iso); }
function fmtTime(iso: string | null): string { return fmtTimeTz(iso); }

type Props = {
  productionId: string;
  eventId: string;
  event: ProductionEvent;
  scheduleItems: EventScheduleItemWithParticipants[];
  callTimes: EventCallTime[];
  departments: EventDepartment[];
};

export default function CallSheetClient({
  productionId, eventId, event,
  scheduleItems, callTimes, departments,
}: Props) {
  const deptMap = new Map(departments.map(d => [d.id, d.name]));

  const sortedItems = [...scheduleItems].sort((a, b) => {
    if (!a.startTime && !b.startTime) return a.orderIndex - b.orderIndex;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  const sortedCallTimes = [...callTimes].sort(
    (a, b) => new Date(a.callAt).getTime() - new Date(b.callAt).getTime()
  );

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        {/* Nav */}
        <div className="flex items-center gap-3 mb-5 text-xs text-zinc-400">
          <Link href={`/production/${productionId}/events/${eventId}/view`} className="hover:text-zinc-600">
            ← 事件详情
          </Link>
        </div>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-bold text-zinc-800 leading-tight">{event.title}</h1>
            <span className="shrink-0 text-xs text-zinc-400 bg-zinc-100 px-2 py-1 rounded-full">
              {STATUS_LABELS[event.status] ?? event.status}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-zinc-500">
            <span>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
            {event.startTime && <span>{fmt(event.startTime)}</span>}
            {event.endTime && event.endTime !== event.startTime && <span>→ {fmt(event.endTime)}</span>}
            {event.location && <span>· {event.location}</span>}
          </div>
        </div>

        {/* Schedule */}
        <section className="mb-6">
          <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-3">事件流程</h2>
          {sortedItems.length === 0 ? (
            <p className="text-xs text-zinc-300 py-4 text-center">暂无流程项</p>
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
                        <SmartText content={item.notes} plugins={[scriptRefTextPlugin]} className="text-[11px] text-zinc-400 mt-0.5 italic" productionId={productionId} />
                      )}
                    </div>
                    {(item.startTime || item.endTime) && (
                      <div className="shrink-0 text-right text-xs text-zinc-500 font-mono">
                        {fmtTime(item.startTime)}
                        {item.endTime && item.endTime !== item.startTime && (
                          <span className="text-zinc-300"> – {fmtTime(item.endTime)}</span>
                        )}
                      </div>
                    )}
                  </div>
                  {item.participants.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {item.participants.map(p => (
                        <span key={p.openId} className="text-[10px] bg-zinc-50 text-zinc-400 rounded px-1.5 py-0.5">
                          {p.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Call times */}
        <section>
          <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-3">Call 时间</h2>
          {sortedCallTimes.length === 0 ? (
            <p className="text-xs text-zinc-300 py-4 text-center">暂无 Call 安排</p>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden divide-y divide-zinc-50">
              {sortedCallTimes.map(ct => (
                <div key={ct.id} className="px-5 py-3 flex items-center gap-4">
                  <span className="shrink-0 font-mono text-sm font-semibold text-zinc-700 w-12">
                    {fmtTime(ct.callAt)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-zinc-800">{ct.name}</span>
                    {ct.departmentId && deptMap.has(ct.departmentId) && (
                      <span className="ml-2 text-[11px] text-zinc-400">{deptMap.get(ct.departmentId)}</span>
                    )}
                    {ct.notes && (
                      <SmartText content={ct.notes} plugins={[scriptRefTextPlugin]} className="text-[11px] text-zinc-400 mt-0.5" productionId={productionId} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
