"use client";

import React, { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { ProductionEvent, EventScheduleItemWithParticipants, EventCallTime, EventTechReq, EventReport, EventDepartment } from "@/lib/ops/event-db";
import { fmtDateTime as fmt } from "@/lib/tz";
import CallTimeTab from "./event-detail/CallTimeTab";
import EventRelationsTab from "./event-detail/EventRelationsTab";
import InfoTab from "./event-detail/InfoTab";
import PublishTab from "./event-detail/PublishTab";
import ReportsTab from "./event-detail/ReportsTab";
import ScheduleTab from "./event-detail/ScheduleTab";
import TechReqTab from "./event-detail/TechReqTab";
import { EVENT_TYPE_LABELS, STATUS_LABELS } from "./event-detail/labels";
import { toLocalDate, isSingleDayEvent } from "./event-detail/time";

// ─── Main component ───────────────────────────────────────────────────────────

const TABS = [
  { id: "info",           label: "基本信息" },
  { id: "schedule",       label: "事件流程" },
  { id: "tech",           label: "技术提需" },
  { id: "relations",      label: "关联任务与里程碑" },
  { id: "call",           label: "Call Time" },
  { id: "publish",        label: "发布" },
  { id: "reports",        label: "报告" },
  { id: "publish_reports",label: "发布报告" },
] as const;
type Tab = typeof TABS[number]["id"];

type Props = {
  productionId: string;
  productionName: string;
  event: ProductionEvent;
  initialScheduleItems: EventScheduleItemWithParticipants[];
  initialEventPeople: { userId: string; name: string }[];
  initialCallTimes: EventCallTime[];
  initialTechReqs: EventTechReq[];
  relationTaskOptions: { id: string; title: string; status: string; eventId: string | null; eventTitle: string | null }[];
  milestoneOptions: { id: string; name: string; endDate: string }[];
  initialEventMilestoneIds: string[];
  initialReports: EventReport[];
  departments: EventDepartment[];
  members: MemberWithRoles[];
  canEdit: boolean;
  canScheduleEdit: boolean;
  canAssignPeople: boolean;
  canCallEdit: boolean;
  canTechReqDelete: boolean;
  canWriteReport: boolean;
  canEditAnyTechReq: boolean;
  pocDeptIds: string[];
  currentUserId: string;
  selfParticipantRole: "participant" | "follower" | null;
  needsSelfConfirm?: boolean;
  selfConfirmLevel?: "edit" | "manage";
};

export default function EventDetailClient({
  productionId, event: initialEvent,
  initialScheduleItems, initialTechReqs, initialCallTimes,
  relationTaskOptions, milestoneOptions, initialEventMilestoneIds,
  initialReports, departments, members,
  canEdit: initialCanEdit, canScheduleEdit: initialCanScheduleEdit,
  canAssignPeople: initialCanAssignPeople, canCallEdit: initialCanCallEdit,
  canTechReqDelete, canWriteReport: initialCanWriteReport,
  canEditAnyTechReq: initialCanEditAnyTechReq, pocDeptIds,
  currentUserId,
  selfParticipantRole: initialSelfRole,
  needsSelfConfirm = false,
  selfConfirmLevel,
}: Props) {
  const [tab, setTab] = useState<Tab>("info");
  const [event, setEvent] = useState(initialEvent);
  const [selfRole, setSelfRole] = useState(initialSelfRole);
  const [followBusy, setFollowBusy] = useState(false);
  const [scheduleItems, setScheduleItems] = useState(initialScheduleItems);
  const [callTimes, setCallTimes] = useState(initialCallTimes);
  const [techReqs, setTechReqs] = useState(initialTechReqs);
  const [reports, setReports] = useState(initialReports);
  const [relationTaskIds, setRelationTaskIds] = useState<string[]>(() => relationTaskOptions.filter(task => task.eventId === initialEvent.id).map(task => task.id));
  const [eventMilestoneIds, setEventMilestoneIds] = useState(initialEventMilestoneIds);

  // Level 2-A: self-confirm modal state
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);
  // Effective capability flags — flip to true after self-confirm
  const [canEdit, setCanEdit] = useState(initialCanEdit);
  const [canScheduleEdit, setCanScheduleEdit] = useState(initialCanScheduleEdit);
  const [canAssignPeople, setCanAssignPeople] = useState(initialCanAssignPeople);
  const [canCallEdit, setCanCallEdit] = useState(initialCanCallEdit);
  const [canWriteReport, setCanWriteReport] = useState(initialCanWriteReport);
  const [canEditAnyTechReq, setCanEditAnyTechReq] = useState(initialCanEditAnyTechReq);

  async function handleSelfConfirm() {
    if (!selfConfirmLevel || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/events/${event.id}/access`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "self_confirm", level: selfConfirmLevel }) },
      );
      if (res.ok) {
        setConfirmDone(true);
        setCanEdit(true);
        setCanScheduleEdit(true);
        setCanAssignPeople(true);
        setCanCallEdit(true);
        setCanWriteReport(true);
        setCanEditAnyTechReq(true);
      }
    } finally {
      setConfirmBusy(false);
    }
  }

  function handleTechReqsCreated(newReqs: EventTechReq[]) {
    setTechReqs(prev => {
      const map = new Map(prev.map(r => [r.id, r]));
      for (const r of newReqs) map.set(r.id, r);
      return [...map.values()];
    });
  }

  // Derived: union of all schedule item participants + tech req assignees
  const eventPeople = useMemo(() => {
    const seen = new Set<string>();
    const people: { userId: string; name: string }[] = [];
    for (const item of scheduleItems) {
      for (const p of item.participants) {
        if (!seen.has(p.userId)) { seen.add(p.userId); people.push(p); }
      }
    }
    for (const tr of techReqs) {
      for (const a of tr.assignees) {
        if (!seen.has(a.userId)) { seen.add(a.userId); people.push({ userId: a.userId, name: a.name }); }
      }
    }
    return people.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [scheduleItems, techReqs]);

  const handleDeleted = useCallback(() => {
    window.location.href = `${BASE_PATH}/production/${productionId}/events`;
  }, [productionId]);

  const toggleFollow = useCallback(async () => {
    setFollowBusy(true);
    try {
      const method = selfRole === "follower" ? "DELETE" : "POST";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/follow`, { method });
      if (res.ok) {
        const data = await res.json();
        setSelfRole(data.role ?? null);
      }
    } finally {
      setFollowBusy(false);
    }
  }, [selfRole, productionId, event.id]);

  // When the event has no explicit times, auto-derive from child items.
  const handleItemsChange = useCallback(async (items: EventScheduleItemWithParticipants[]) => {
    setScheduleItems(items);
    if (!event.startTime && !event.endTime) {
      const starts = items.flatMap(i => i.startTime ? [i.startTime] : []);
      const ends = items.flatMap(i => i.endTime ? [i.endTime] : []);
      if (starts.length && ends.length) {
        const derivedStart = starts.reduce((a, b) => a < b ? a : b);
        const derivedEnd = ends.reduce((a, b) => a > b ? a : b);
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startTime: derivedStart, endTime: derivedEnd }),
        });
        const data = await res.json();
        if (data.event) setEvent(data.event);
      }
    }
  }, [event, productionId]);

  const statusStyle: Record<string, { background: string; color: string }> = {
    draft:     { background: "var(--paper)",  color: "var(--muted)" },
    published: { background: "#eff6ff",       color: "#2563eb" },
    completed: { background: "#f0fdf4",       color: "#16a34a" },
    cancelled: { background: "#fff1f2",       color: "#e11d48" },
  };

  const navLink: React.CSSProperties = { fontSize: 11, color: "var(--muted)", textDecoration: "none" };

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>

      {/* Level 2-A: self-confirm modal for users in the free-approval zone */}
      {needsSelfConfirm && !confirmDone && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "white", borderRadius: 12, padding: "32px 36px",
            maxWidth: 420, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,.18)",
          }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700 }}>进入编辑模式</h2>
            <p style={{ margin: "0 0 24px", color: "#555", fontSize: 14, lineHeight: 1.6 }}>
              你的部门对此演出事件有编辑权限。点击确认后，将为你开通{selfConfirmLevel === "manage" ? "管理" : "编辑"}级别访问权限，无需等待审批。
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <a href={`/production/${productionId}/events/${event.id}/view`}
                style={{ padding: "8px 20px", borderRadius: 8, border: "1px solid #ddd", fontSize: 14, textDecoration: "none", color: "#333" }}>
                仅查看
              </a>
              <button
                onClick={handleSelfConfirm}
                disabled={confirmBusy}
                style={{ padding: "8px 20px", borderRadius: 8, background: "#1677ff", color: "white", border: "none", fontSize: 14, cursor: confirmBusy ? "wait" : "pointer", opacity: confirmBusy ? 0.7 : 1 }}>
                {confirmBusy ? "确认中…" : "进入编辑"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Eyebrow + utility links — outside the page sheet */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href={`/production/${productionId}/events`} style={{ ...navLink, display: "inline-flex", alignItems: "center", gap: 4 }}>← 返回事件列表</Link>
          <span aria-hidden style={{ color: "var(--line)" }}>|</span>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", margin: 0 }}>
            Schedule
          </p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <Link href={`/production/${productionId}/events/${event.id}/view`} style={navLink}>关注者视角</Link>
          <Link href={`/production/${productionId}/events/${event.id}/callsheet`} style={navLink}>Call Sheet</Link>
          <Link href={`/production/${productionId}/events/${event.id}/reqs`} style={navLink}>技术需求</Link>
        </div>
      </div>

      {/* Page sheet */}
      <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: 12, padding: "24px 28px" }}>

        {/* Title row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", margin: 0, lineHeight: 1.2 }}>
            {event.title}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingTop: 2 }}>
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
            <span style={{ borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, ...(statusStyle[event.status] ?? statusStyle.draft) }}>
              {STATUS_LABELS[event.status] ?? event.status}
            </span>
          </div>
        </div>

        {/* Event meta */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 12px", marginBottom: 20 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
          {event.startTime && <span style={{ fontSize: 12, color: "var(--muted)" }}>{fmt(event.startTime)}</span>}
          {event.location && <span style={{ fontSize: 12, color: "var(--muted)" }}>{event.location}</span>}
          <span style={{ fontSize: 11, borderRadius: 4, background: "var(--paper)", border: "1px solid var(--line)", padding: "1px 6px", color: "var(--muted)" }}>
            {canEdit ? "可编辑" : "只读"}
          </span>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 20, overflowX: "auto", WebkitOverflowScrolling: "touch" as React.CSSProperties["WebkitOverflowScrolling"], scrollbarWidth: "none" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "8px 16px", fontSize: 12, fontWeight: 600, border: 0, background: "none",
              cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
              borderBottom: `2px solid ${tab === t.id ? "var(--ink)" : "transparent"}`,
              color: tab === t.id ? "var(--ink)" : "var(--muted)",
              marginBottom: -1, transition: "color .1s",
            }}>
              {t.label}
            </button>
          ))}
        </div>

      {/* Tab content */}
      {tab === "info" && (
        <InfoTab
          event={event} productionId={productionId} members={members} canEdit={canEdit}
          departments={departments}
          onUpdated={setEvent} onDeleted={handleDeleted}
          onTechReqsCreated={handleTechReqsCreated}
        />
      )}
      {tab === "schedule" && (
        <ScheduleTab
          eventId={event.id} productionId={productionId}
          items={scheduleItems} onItemsChange={handleItemsChange}
          canEdit={canScheduleEdit} canAssignPeople={canAssignPeople}
          members={members}
          eventStart={event.startTime} eventEnd={event.endTime}
          singleDay={isSingleDayEvent(event)}
          eventDate={toLocalDate(event.startTime)}
          departments={departments}
          onTechReqsCreated={handleTechReqsCreated}
          versionId={event.versionId ?? null}
        />
      )}
      {tab === "call" && (
        <CallTimeTab
          eventId={event.id} productionId={productionId}
          callTimes={callTimes} eventPeople={eventPeople}
          scheduleItems={scheduleItems} techReqs={techReqs}
          members={members}
          stageManagerUserIds={new Set(event.stageManagers.map(m => m.userId))}
          canEdit={canCallEdit}
          singleDay={isSingleDayEvent(event)}
          eventDate={toLocalDate(event.startTime)}
          onCallTimesChange={setCallTimes}
          versionId={event.versionId ?? null}
        />
      )}
      {tab === "tech" && (
        <TechReqTab
          eventId={event.id} productionId={productionId}
          techReqs={techReqs} departments={departments} members={members}
          scheduleItems={scheduleItems}
          canEdit={canEditAnyTechReq} canDelete={canTechReqDelete}
          pocDeptIds={pocDeptIds}
          eventStatus={event.status}
          onTechReqsChange={setTechReqs}
          versionId={event.versionId ?? null}
        />
      )}
      {tab === "relations" && (
        <EventRelationsTab
          productionId={productionId}
          eventId={event.id}
          tasks={relationTaskOptions}
          taskIds={relationTaskIds}
          milestoneOptions={milestoneOptions}
          milestoneIds={eventMilestoneIds}
          canEdit={canEdit}
          onSaved={(taskIds, milestoneIds) => { setRelationTaskIds(taskIds); setEventMilestoneIds(milestoneIds); }}
        />
      )}
      {tab === "publish" && (
        <PublishTab
          event={event} productionId={productionId}
          scheduleItems={scheduleItems} callTimes={callTimes}
          eventPeople={eventPeople}
          techReqs={techReqs}
          canEdit={canEdit}
          onUpdated={setEvent}
        />
      )}
      {tab === "publish_reports" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reports.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "24px 0" }}>暂无报告</p>
          )}
          {reports.map(r => {
            const isPublished = !!r.publishedAt;
            async function togglePublish() {
              const publishedAt = isPublished ? null : new Date().toISOString();
              const res = await fetch(
                `${BASE_PATH}/api/production/${productionId}/events/${event.id}/reports/${r.id}`,
                { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publishedAt }) }
              );
              const data = await res.json();
              if (data.report) setReports(prev => prev.map(x => x.id === r.id ? data.report : x));
            }
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "12px 16px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                </div>
                <span style={{ flexShrink: 0, fontSize: 11, borderRadius: 20, padding: "2px 8px", fontWeight: 600,
                  background: isPublished ? "#f0fdf4" : "var(--paper)", color: isPublished ? "#16a34a" : "var(--muted)" }}>
                  {isPublished ? "已发布" : "草稿"}
                </span>
                {canWriteReport && (
                  <button onClick={togglePublish}
                    style={{ flexShrink: 0, padding: "5px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .1s",
                      background: isPublished ? "white" : "#16a34a", color: isPublished ? "var(--ink)" : "#fff",
                      border: isPublished ? "1px solid var(--line)" : "none" }}>
                    {isPublished ? "撤回" : "发布"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {tab === "reports" && (
        <ReportsTab
          eventId={event.id} productionId={productionId}
          reports={reports} departments={departments}
          members={members.map(m => ({ userId: m.userId, name: m.name }))}
          canWrite={canWriteReport}
          currentUserId={currentUserId}
          versionId={event.versionId ?? null}
          onReportsChange={setReports}
        />
      )}

      </div>{/* end page sheet */}
    </div>
  );
}
