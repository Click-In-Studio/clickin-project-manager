"use client";

import type { CSSProperties } from "react";
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

  const rule: CSSProperties = { border: "none", borderTop: "1px solid var(--line)", margin: 0 };
  const sectionBar: CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase",
    color: "var(--muted)", padding: "10px 0", margin: 0,
  };

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>

      {/* Eyebrow + nav link */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", margin: 0 }}>
          Call Sheet
        </p>
        <Link
          href={`/production/${productionId}/events/${eventId}/view`}
          style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}
        >
          ← 事件详情
        </Link>
      </div>

      {/* Page sheet */}
      <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: 12, padding: "24px 28px" }}>

        {/* Document title block */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", margin: 0, lineHeight: 1.2 }}>
            {event.title}
          </h1>
          <span style={{ flexShrink: 0, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, background: "var(--paper)", color: "var(--muted)", paddingTop: 4 }}>
            {STATUS_LABELS[event.status] ?? event.status}
          </span>
        </div>

        {/* Meta */}
        <hr style={rule} />
        <div style={{ padding: "14px 0" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 16px" }}>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
            {event.startTime && <span style={{ fontSize: 12, color: "var(--muted)" }}>{fmt(event.startTime)}</span>}
            {event.endTime && event.endTime !== event.startTime && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>→ {fmt(event.endTime)}</span>
            )}
            {event.location && <span style={{ fontSize: 12, color: "var(--muted)" }}>· {event.location}</span>}
          </div>
        </div>

        {/* Schedule section */}
        <hr style={rule} />
        <p style={sectionBar}>事件流程</p>
        <hr style={rule} />

        {sortedItems.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--muted)", padding: "20px 0", textAlign: "center" }}>暂无流程项</p>
        ) : (
          <div>
            {sortedItems.map(item => (
              <div key={item.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--line)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{item.title}</span>
                      {item.itemType !== "custom" && (
                        <span style={{ flexShrink: 0, borderRadius: 4, background: "var(--line)", padding: "1px 6px", fontSize: 10, color: "var(--muted)" }}>
                          {ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
                        </span>
                      )}
                    </div>
                    {item.location && (
                      <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{item.location}</p>
                    )}
                    {item.notes && (
                      <SmartText content={item.notes} plugins={[scriptRefTextPlugin]} className="text-[11px] text-zinc-400 mt-0.5 italic" productionId={productionId} />
                    )}
                    {item.participants.length > 0 && (
                      <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                        {item.participants.map(p => p.name).join("、")}
                      </p>
                    )}
                  </div>
                  {(item.startTime || item.endTime) && (
                    <div style={{ flexShrink: 0, textAlign: "right", fontSize: 12, color: "var(--muted)", fontFamily: "monospace" }}>
                      {fmtTime(item.startTime)}
                      {item.endTime && item.endTime !== item.startTime && (
                        <span style={{ color: "var(--line)" }}> – {fmtTime(item.endTime)}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Call times section */}
        <div style={{ marginTop: 28 }}>
          <hr style={rule} />
          <p style={sectionBar}>Call 时间</p>
          <hr style={rule} />
        </div>

        {sortedCallTimes.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--muted)", padding: "20px 0", textAlign: "center" }}>暂无 Call 安排</p>
        ) : (
          <div>
            {sortedCallTimes.map(ct => (
              <div key={ct.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ flexShrink: 0, fontFamily: "monospace", fontSize: 13, fontWeight: 600, color: "var(--ink)", minWidth: 44 }}>
                  {fmtTime(ct.callAt)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, color: "var(--ink)" }}>{ct.name}</span>
                  {ct.departmentId && deptMap.has(ct.departmentId) && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>{deptMap.get(ct.departmentId)}</span>
                  )}
                  {ct.notes && (
                    <SmartText content={ct.notes} plugins={[scriptRefTextPlugin]} className="text-[11px] text-zinc-400 mt-0.5" productionId={productionId} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>{/* end page sheet */}
    </div>
  );
}
