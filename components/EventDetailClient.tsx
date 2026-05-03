"use client";

import { useState, useCallback, useMemo, Fragment } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import type {
  ProductionEvent, EventScheduleItemWithParticipants, ScheduleItemParticipant,
  EventCallTime, EventTechReq, EventReport, EventReportNote, EventDepartment,
} from "@/lib/event-db";
// ─── Shared helpers ───────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练",
  performance: "演出",
  meeting: "会议",
  custom: "其他",
};
const SCHEDULE_ITEM_TYPE_LABELS: Record<string, string> = {
  scene_rehearsal: "场景排练",
  fitting: "服装",
  sound_check: "音响",
  tech_rehearsal: "技排",
  meeting: "会议",
  break: "休息",
  custom: "其他",
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
const TECH_STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};
const TECH_STATUS_COLORS: Record<string, string> = {
  awaiting: "bg-purple-50 text-purple-500",
  pending: "bg-amber-50 text-amber-600",
  in_progress: "bg-blue-50 text-blue-600",
  done: "bg-green-50 text-green-600",
};

import { isoToDatetimeLocal, isoToDateInput, isoToTimeInput, datetimeLocalToIso, dateTimeToIso, fmtDateTime as fmt, fmtTime, fmtDateLong } from "@/lib/tz";
import MarkdownEditor from "@/components/MarkdownEditor";
import MarkdownView from "@/components/MarkdownView";
import MentionTextarea, { type MentionMember } from "@/components/MentionTextarea";
import SmartTextarea, { scriptRefDropPlugin, memberDropPlugin } from "@/components/SmartTextarea";
import SmartText, { scriptRefTextPlugin, memberTextPlugin } from "@/components/SmartText";
import type { Version } from "@/lib/db";

function toLocalInput(iso: string | null)     { return isoToDatetimeLocal(iso); }
function toLocalDate(iso: string | null)       { return isoToDateInput(iso); }
function toLocalTimeInput(iso: string | null)  { return isoToTimeInput(iso); }
function isSingleDayEvent(event: ProductionEvent): boolean {
  if (!event.startTime || !event.endTime) return false;
  const s = isoToDatetimeLocal(event.startTime);
  const e = isoToDatetimeLocal(event.endTime);
  return s.slice(0, 10) === e.slice(0, 10) && s.slice(11) === "00:00" && e.slice(11) === "23:59";
}

// ─── InfoTab ──────────────────────────────────────────────────────────────────

const SM_EVENT_TYPES = new Set(["rehearsal", "meeting"]);

function InfoTab({
  event, productionId, members, canEdit, departments, versions,
  onUpdated, onDeleted, onTechReqsCreated,
}: {
  event: ProductionEvent; productionId: string;
  members: MemberWithRoles[];
  canEdit: boolean;
  departments: EventDepartment[];
  versions?: Version[];
  onUpdated: (ev: ProductionEvent) => void;
  onDeleted: () => void;
  onTechReqsCreated?: (reqs: EventTechReq[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(event.title);
  const [eventType, setEventType] = useState(event.eventType);
  const [location, setLocation] = useState(event.location);
  const [singleDay, setSingleDay] = useState(() => isSingleDayEvent(event));
  const [singleDate, setSingleDate] = useState(() => toLocalDate(event.startTime));
  const [startTime, setStartTime] = useState(toLocalInput(event.startTime));
  const [endTime, setEndTime] = useState(toLocalInput(event.endTime));
  const [description, setDescription] = useState(event.description);
  const [stageManagers, setStageManagers] = useState<{ openId: string; name: string }[]>(event.stageManagers);
  const [versionId, setVersionId] = useState<string | null>(event.versionId ?? null);
  const [notifyDeptIds, setNotifyDeptIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const showSM = SM_EVENT_TYPES.has(eventType);
  const smMembers = members.filter(m =>
    m.roles.some(r => r === "舞台监督" || r === "助理舞台监督")
  );

  async function saveInfo() {
    setSaving(true);
    const resolvedStart = singleDay ? (singleDate ? dateTimeToIso(singleDate, "00:00") : null) : (startTime ? datetimeLocalToIso(startTime) : null);
    const resolvedEnd   = singleDay ? (singleDate ? dateTimeToIso(singleDate, "23:59") : null) : (endTime   ? datetimeLocalToIso(endTime)   : null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(), eventType, location: location.trim(),
        startTime: resolvedStart, endTime: resolvedEnd,
        description: description.trim(),
        stageManagers: showSM ? stageManagers : [],
        versionId,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.event) {
      if (notifyDeptIds.length > 0 && onTechReqsCreated) {
        const awRes = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/awaiting-reqs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentIds: notifyDeptIds }),
        });
        if (awRes.ok) {
          const awData = await awRes.json();
          onTechReqsCreated(awData.techReqs);
        }
      }
      setNotifyDeptIds([]);
      onUpdated(data.event);
      setEditing(false);
    }
  }

  async function deleteEvent() {
    await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}`, { method: "DELETE" });
    onDeleted();
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">标题</label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">类型</label>
            <select value={eventType} onChange={e => setEventType(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
              <option value="rehearsal">排练</option>
              <option value="performance">演出</option>
              <option value="meeting">会议</option>
              <option value="custom">其他</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">地点</label>
            <input value={location} onChange={e => setLocation(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={singleDay} onChange={e => setSingleDay(e.target.checked)}
              className="rounded" />
            <span className="text-xs text-zinc-600">单日事件</span>
          </label>
        </div>
        {singleDay ? (
          <div>
            <label className="block text-xs text-zinc-500 mb-1">日期</label>
            <input type="date" value={singleDate} onChange={e => setSingleDate(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">开始</label>
              <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">结束</label>
              <input type="datetime-local" value={endTime} onChange={e => setEndTime(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </div>
          </div>
        )}
        {versions && versions.length > 0 && (
          <div>
            <label className="block text-xs text-zinc-500 mb-1">版本</label>
            <select
              value={versionId ?? ""}
              onChange={e => setVersionId(e.target.value || null)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400"
            >
              <option value="">不限定版本</option>
              {versions.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">备注</label>
          <SmartTextarea value={description} onChange={setDescription} rows={3}
            plugins={[scriptRefDropPlugin(productionId, versionId)]}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
        </div>
        {showSM && (
          <div>
            <label className="block text-xs text-zinc-500 mb-1">跟组舞监</label>
            {smMembers.length === 0 ? (
              <p className="text-xs text-zinc-400">无舞台监督 / 助理舞台监督成员</p>
            ) : (
              <AssigneeEditorInline
                members={smMembers.map(m => ({ ...m, roles: m.roles.filter(r => r === "舞台监督" || r === "助理舞台监督") }))}
                assignees={stageManagers}
                onChange={setStageManagers}
              />
            )}
          </div>
        )}
        {departments.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-zinc-500">通知部门（创建待确认需求）</label>
              <button type="button"
                onClick={() => setNotifyDeptIds(
                  notifyDeptIds.length === departments.length ? [] : departments.map(d => d.id)
                )}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >{notifyDeptIds.length === departments.length ? "取消全选" : "全选"}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {departments.map(d => (
                <button key={d.id} type="button"
                  onClick={() => setNotifyDeptIds(prev =>
                    prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id]
                  )}
                  className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                    notifyDeptIds.includes(d.id)
                      ? "bg-zinc-800 text-white border-zinc-800"
                      : "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400"
                  }`}
                >{d.name}</button>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={saveInfo} disabled={saving}
            className="px-4 py-2 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50">
            {saving ? "保存中…" : "保存"}
          </button>
          <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700">取消</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-zinc-400 mb-0.5">类型</dt>
          <dd className="text-zinc-700">{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400 mb-0.5">地点</dt>
          <dd className="text-zinc-700">{event.location || "—"}</dd>
        </div>
        {isSingleDayEvent(event) ? (
          <div className="col-span-2">
            <dt className="text-xs text-zinc-400 mb-0.5">日期</dt>
            <dd className="text-zinc-700">
              单日 · {fmtDateLong(event.startTime!)}
            </dd>
          </div>
        ) : (
          <>
            <div>
              <dt className="text-xs text-zinc-400 mb-0.5">开始</dt>
              <dd className="text-zinc-700">{fmt(event.startTime)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400 mb-0.5">结束</dt>
              <dd className="text-zinc-700">{fmt(event.endTime)}</dd>
            </div>
          </>
        )}
        {event.description && (
          <div className="col-span-2">
            <dt className="text-xs text-zinc-400 mb-0.5">备注</dt>
            <dd className="text-zinc-700"><SmartText content={event.description} plugins={[scriptRefTextPlugin]} /></dd>
          </div>
        )}
        {SM_EVENT_TYPES.has(event.eventType) && (
          <div className="col-span-2">
            <dt className="text-xs text-zinc-400 mb-0.5">跟组舞监</dt>
            <dd className="text-zinc-700 font-medium">
              {event.stageManagers.length > 0 ? event.stageManagers.map(m => m.name).join("、") : "—"}
            </dd>
          </div>
        )}
      </dl>

      {canEdit && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={() => setEditing(true)}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 text-xs text-zinc-600 hover:bg-zinc-50">
            编辑信息
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-red-500">确认删除？</span>
              <button onClick={deleteEvent} className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium">确认</button>
              <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-500">取消</button>
            </span>
          ) : (
            <button onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 rounded-lg border border-red-200 text-xs text-red-400 hover:bg-red-50 ml-auto">
              删除事件
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared: member card + grouped picker helpers ─────────────────────────────

function groupByRole(members: MemberWithRoles[]): { role: string; members: MemberWithRoles[] }[] {
  const order: string[] = [];
  const map = new Map<string, MemberWithRoles[]>();
  for (const m of members) {
    const roles = m.roles.length > 0 ? m.roles : ["其他"];
    for (const role of roles) {
      if (!map.has(role)) { map.set(role, []); order.push(role); }
      map.get(role)!.push(m);
    }
  }
  return order.map(role => ({ role, members: map.get(role)! }));
}

function MemberCard({
  m, isSelected, onToggle,
}: { m: MemberWithRoles; isSelected: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      className={`text-left rounded-lg px-3 py-2 transition-colors ${
        isSelected ? "bg-zinc-800 text-white" : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
      }`}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-sm font-medium truncate">{m.name}</span>
        {isSelected && <span className="shrink-0 text-[10px] opacity-50">×</span>}
      </div>
      {m.roles.length > 0 && (
        <p className={`text-[11px] truncate mt-0.5 ${isSelected ? "text-zinc-300" : "text-zinc-400"}`}>
          {m.roles.join("、")}
        </p>
      )}
    </button>
  );
}

// ─── ParticipantPicker ────────────────────────────────────────────────────────

function ParticipantPicker({
  members, selected, onChange,
  departments = [], selectedDeptIds = [], onDeptIdsChange,
}: {
  members: MemberWithRoles[];
  selected: ScheduleItemParticipant[];
  onChange: (next: ScheduleItemParticipant[]) => void;
  departments?: EventDepartment[];
  selectedDeptIds?: string[];
  onDeptIdsChange?: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selected.map(p => p.openId));
  const memberMap = new Map(members.map(m => [m.openId, m]));

  // Build dept groups (each member shown in every dept they belong to)
  const deptGroups = departments
    .map(dept => ({
      dept,
      members: dept.memberOpenIds
        .map(oid => memberMap.get(oid))
        .filter((m): m is MemberWithRoles => !!m),
    }))
    .filter(g => g.members.length > 0);

  // Role groups: members not in any dept
  const inAnyDept = new Set(departments.flatMap(d => d.memberOpenIds));
  const nonDeptMembers = members.filter(m => !inAnyDept.has(m.openId));

  function toggle(m: MemberWithRoles) {
    if (selectedSet.has(m.openId)) {
      onChange(selected.filter(p => p.openId !== m.openId));
    } else {
      onChange([...selected, { openId: m.openId, name: m.name }]);
    }
  }

  function toggleDept(dept: EventDepartment, deptMembers: MemberWithRoles[]) {
    if (selectedDeptIds.includes(dept.id)) {
      // Detach dept but keep any members already in the participant list
      onDeptIdsChange?.(selectedDeptIds.filter(id => id !== dept.id));
    } else {
      // Attach dept and bulk-add all its members not yet selected
      onDeptIdsChange?.([...selectedDeptIds, dept.id]);
      const toAdd = deptMembers
        .filter(m => !selectedSet.has(m.openId))
        .map(m => ({ openId: m.openId, name: m.name }));
      if (toAdd.length > 0) onChange([...selected, ...toAdd]);
    }
  }

  // Apply search
  const filteredDeptGroups = deptGroups
    .map(g => ({
      ...g,
      members: search
        ? g.members.filter(m => m.name.includes(search) || m.roles.some(r => r.includes(search)))
        : g.members,
    }))
    .filter(g => !search || g.members.length > 0);

  const filteredNonDept = search
    ? nonDeptMembers.filter(m => m.name.includes(search) || m.roles.some(r => r.includes(search)))
    : nonDeptMembers;
  const roleGroups = groupByRole(filteredNonDept);

  const empty = filteredDeptGroups.every(g => g.members.length === 0) && filteredNonDept.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <input placeholder="搜索姓名或职位…" value={search} onChange={e => setSearch(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
      {empty && <p className="text-xs text-zinc-400">无匹配成员</p>}
      <div className="max-h-64 overflow-y-auto flex flex-col gap-3">
        {filteredDeptGroups.map(({ dept, members: gm }) => {
          const attached = selectedDeptIds.includes(dept.id);
          return (
            <div key={dept.id}>
              <button
                type="button"
                onClick={() => toggleDept(dept, gm)}
                className={`flex items-center gap-1.5 mb-1.5 hover:opacity-75 transition-opacity ${
                  attached ? "text-zinc-700" : "text-zinc-400"
                }`}
              >
                <span className="text-[11px] font-semibold tracking-widest uppercase">{dept.name}</span>
                {attached
                  ? <span className="text-[10px] rounded bg-zinc-700 text-white px-1 py-0.5 leading-none">已关联 ×</span>
                  : <span className="text-[10px] rounded border border-zinc-300 text-zinc-400 px-1 py-0.5 leading-none">+ 关联</span>
                }
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                {gm.map(m => (
                  <MemberCard key={m.openId} m={m} isSelected={selectedSet.has(m.openId)} onToggle={() => toggle(m)} />
                ))}
              </div>
            </div>
          );
        })}
        {roleGroups.map(({ role, members: gm }) => (
          <div key={role}>
            <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-1.5">{role}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {gm.map(m => (
                <MemberCard key={m.openId} m={m} isSelected={selectedSet.has(m.openId)} onToggle={() => toggle(m)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ScheduleTab ──────────────────────────────────────────────────────────────

function ScheduleTab({
  eventId, productionId, items, onItemsChange, canEdit, canAssignPeople, members,
  eventStart, eventEnd, singleDay, eventDate,
  departments = [], onTechReqsCreated, versionId,
}: {
  eventId: string; productionId: string;
  items: EventScheduleItemWithParticipants[];
  onItemsChange: (items: EventScheduleItemWithParticipants[]) => void;
  canEdit: boolean; canAssignPeople: boolean;
  members: MemberWithRoles[];
  eventStart: string | null; eventEnd: string | null;
  singleDay: boolean; eventDate: string;
  departments?: EventDepartment[];
  onTechReqsCreated?: (reqs: EventTechReq[]) => void;
  versionId: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("custom");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newLoc, setNewLoc] = useState("");
  const [newParticipants, setNewParticipants] = useState<ScheduleItemParticipant[]>([]);
  const [newDeptIds, setNewDeptIds] = useState<string[]>([]);
  const [newNotifyDepts, setNewNotifyDepts] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "table">("list");

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule`;

  function resolveItemTime(val: string): string | null {
    if (!val) return null;
    return datetimeLocalToIso(singleDay && eventDate ? `${eventDate}T${val}` : val);
  }

  async function addItem() {
    if (!newTitle.trim()) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newTitle.trim(), itemType: newType,
        startTime: resolveItemTime(newStart), endTime: resolveItemTime(newEnd),
        location: newLoc.trim(), orderIndex: items.length,
        departmentIds: newDeptIds,
      }),
    });
    const data = await res.json();
    if (!data.item) return;
    const newId: string = data.item.id;
    let participants: ScheduleItemParticipant[] = [];
    if (canAssignPeople && newParticipants.length > 0) {
      await fetch(`${base}/${newId}/participants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: newParticipants }),
      });
      participants = newParticipants;
    }
    if (newNotifyDepts.length > 0) {
      const awRes = await fetch(
        `${BASE_PATH}/api/production/${productionId}/events/${eventId}/awaiting-reqs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentIds: newNotifyDepts, scheduleItemId: newId }),
        }
      );
      if (awRes.ok && onTechReqsCreated) {
        const awData = await awRes.json() as { techReqs: EventTechReq[] };
        onTechReqsCreated(awData.techReqs);
      }
    }
    onItemsChange([...items, { ...data.item, participants, departmentIds: newDeptIds }]);
    setNewTitle(""); setNewType("custom"); setNewStart(""); setNewEnd(""); setNewLoc("");
    setNewParticipants([]);
    setNewDeptIds([]);
    setNewNotifyDepts([]);
    setAdding(false);
  }

  async function deleteItem(id: string) {
    await fetch(`${base}/${id}`, { method: "DELETE" });
    onItemsChange(items.filter(i => i.id !== id));
  }

  const sortedItems = [...items].sort((a, b) => {
    if (!a.startTime && !b.startTime) return a.orderIndex - b.orderIndex;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  const minAttr = eventStart ? toLocalInput(eventStart) : undefined;
  const maxAttr = eventEnd ? toLocalInput(eventEnd) : undefined;

  return (
    <div className="flex flex-col gap-3">
      {departments.length > 0 && (
        <div className="flex gap-1 self-end">
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
      {viewMode === "table" ? (
        <ScheduleTableView
          eventId={eventId} productionId={productionId}
          items={items} onItemsChange={onItemsChange}
          canEdit={canEdit} canAssignPeople={canAssignPeople}
          members={members} departments={departments}
          singleDay={singleDay} eventDate={eventDate}
          eventStart={eventStart} eventEnd={eventEnd}
          onTechReqsCreated={onTechReqsCreated}
          versionId={versionId}
        />
      ) : (
        <>
          {items.length === 0 && !adding && (
            <p className="text-sm text-zinc-400 text-center py-6">暂无流程项</p>
          )}
          {sortedItems.map(item => (
            <ScheduleItemRow key={item.id} item={item}
              canEdit={canEdit} canAssignPeople={canAssignPeople} members={members}
              editing={editingId === item.id}
              onEdit={() => setEditingId(editingId === item.id ? null : item.id)}
              onSaved={updated => onItemsChange(items.map(i => i.id === updated.id ? updated : i))}
              onDelete={() => deleteItem(item.id)}
              base={base}
              minTime={minAttr} maxTime={maxAttr}
              singleDay={singleDay} eventDate={eventDate}
              departments={departments}
              productionId={productionId} eventId={eventId}
              onTechReqsCreated={onTechReqsCreated}
              versionId={versionId}
            />
          ))}

          {canEdit && (
        adding ? (
          <div className="rounded-xl bg-white shadow-sm p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="流程标题 *" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <select value={newType} onChange={e => setNewType(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                {Object.entries(SCHEDULE_ITEM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <input placeholder="地点" value={newLoc} onChange={e => setNewLoc(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              {singleDay ? (
                <>
                  <input type="time" value={newStart} onChange={e => setNewStart(e.target.value)}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
                  <input type="time" value={newEnd} onChange={e => setNewEnd(e.target.value)}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
                </>
              ) : (
                <>
                  <input type="datetime-local" value={newStart} min={minAttr} max={maxAttr} onChange={e => setNewStart(e.target.value)}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
                  <input type="datetime-local" value={newEnd} min={minAttr} max={maxAttr} onChange={e => setNewEnd(e.target.value)}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
                </>
              )}
            </div>
            {canAssignPeople && members.length > 0 && (
              <div className="pt-2 border-t border-zinc-100">
                <p className="text-xs text-zinc-400 mb-2">参与人员</p>
                <ParticipantPicker
                  members={members} selected={newParticipants} onChange={setNewParticipants}
                  departments={departments} selectedDeptIds={newDeptIds} onDeptIdsChange={setNewDeptIds}
                />
              </div>
            )}
            {canEdit && departments.length > 0 && (
              <div className="pt-2 border-t border-zinc-100">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-zinc-400">通知部门（创建待确认需求）</p>
                  <button type="button"
                    onClick={() => setNewNotifyDepts(
                      newNotifyDepts.length === departments.length ? [] : departments.map(d => d.id)
                    )}
                    className="text-xs text-zinc-400 hover:text-zinc-600"
                  >{newNotifyDepts.length === departments.length ? "取消全选" : "全选"}</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {departments.map(d => (
                    <button key={d.id} type="button"
                      onClick={() => setNewNotifyDepts(prev =>
                        prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id]
                      )}
                      className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                        newNotifyDepts.includes(d.id)
                          ? "bg-zinc-800 text-white border-zinc-800"
                          : "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400"
                      }`}
                    >{d.name}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={addItem}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700">
                添加
              </button>
              <button onClick={() => { setAdding(false); setNewParticipants([]); setNewDeptIds([]); }}
                className="text-sm text-zinc-500 hover:text-zinc-700">取消</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors">
            + 添加流程项
          </button>
        )
      )}
        </>
      )}
    </div>
  );
}

function ScheduleItemRow({
  item, canEdit, canAssignPeople, members,
  editing, onEdit, onSaved, onDelete, base, minTime, maxTime,
  singleDay, eventDate, departments, productionId, eventId, onTechReqsCreated, versionId,
}: {
  item: EventScheduleItemWithParticipants;
  canEdit: boolean; canAssignPeople: boolean; members: MemberWithRoles[];
  editing: boolean; onEdit: () => void;
  onSaved: (updated: EventScheduleItemWithParticipants) => void;
  onDelete: () => void;
  base: string;
  minTime?: string; maxTime?: string;
  singleDay: boolean; eventDate: string;
  departments?: EventDepartment[];
  productionId: string; eventId: string;
  onTechReqsCreated?: (reqs: EventTechReq[]) => void;
  versionId: string | null;
}) {
  const [title, setTitle] = useState(item.title);
  const [itemType, setItemType] = useState(item.itemType);
  const [startTime, setStartTime] = useState(
    singleDay ? toLocalTimeInput(item.startTime) : toLocalInput(item.startTime)
  );
  const [endTime, setEndTime] = useState(
    singleDay ? toLocalTimeInput(item.endTime) : toLocalInput(item.endTime)
  );
  const [location, setLocation] = useState(item.location);
  const [notes, setNotes] = useState(item.notes);
  const [localParticipants, setLocalParticipants] = useState<ScheduleItemParticipant[]>(item.participants);
  const [localDeptIds, setLocalDeptIds] = useState<string[]>(item.departmentIds ?? []);
  const [notifyDeptIds, setNotifyDeptIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function resolveTime(val: string): string | null {
    if (!val) return null;
    return datetimeLocalToIso(singleDay && eventDate ? `${eventDate}T${val}` : val);
  }

  async function save() {
    setSaving(true);
    const [fieldRes] = await Promise.all([
      fetch(`${base}/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(), itemType,
          startTime: resolveTime(startTime), endTime: resolveTime(endTime),
          location: location.trim(), notes: notes.trim(),
          departmentIds: localDeptIds,
        }),
      }),
      fetch(`${base}/${item.id}/participants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: localParticipants }),
      }),
    ]);
    const data = await fieldRes.json();
    if (data.item) {
      if (notifyDeptIds.length > 0 && onTechReqsCreated) {
        const awRes = await fetch(
          `${BASE_PATH}/api/production/${productionId}/events/${eventId}/awaiting-reqs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ departmentIds: notifyDeptIds, scheduleItemId: item.id }),
          }
        );
        if (awRes.ok) {
          const awData = await awRes.json() as { techReqs: EventTechReq[] };
          onTechReqsCreated(awData.techReqs);
        }
      }
      setNotifyDeptIds([]);
      onSaved({ ...data.item, participants: localParticipants, departmentIds: localDeptIds });
      onEdit();
    }
    setSaving(false);
  }

  function cancel() {
    setTitle(item.title); setItemType(item.itemType);
    setStartTime(singleDay ? toLocalTimeInput(item.startTime) : toLocalInput(item.startTime));
    setEndTime(singleDay ? toLocalTimeInput(item.endTime) : toLocalInput(item.endTime));
    setLocation(item.location); setNotes(item.notes);
    setLocalDeptIds(item.departmentIds ?? []);
    setLocalParticipants(item.participants);
    setNotifyDeptIds([]);
    onEdit();
  }

  if (editing && canEdit) {
    return (
      <div className="rounded-xl bg-white shadow-sm p-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <input value={title} onChange={e => setTitle(e.target.value)}
            className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          <select value={itemType} onChange={e => setItemType(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
            {Object.entries(SCHEDULE_ITEM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input placeholder="地点" value={location} onChange={e => setLocation(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          {singleDay ? (
            <>
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </>
          ) : (
            <>
              <input type="datetime-local" value={startTime} min={minTime} max={maxTime} onChange={e => setStartTime(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <input type="datetime-local" value={endTime} min={minTime} max={maxTime} onChange={e => setEndTime(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </>
          )}
          <SmartTextarea placeholder="备注" value={notes} onChange={setNotes} rows={2}
            plugins={[scriptRefDropPlugin(productionId, versionId)]}
            className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
        </div>

        {canAssignPeople && members.length > 0 && (
          <div className="pt-2 border-t border-zinc-100">
            <p className="text-xs text-zinc-400 mb-2">参与人员</p>
            <ParticipantPicker
              members={members} selected={localParticipants} onChange={setLocalParticipants}
              departments={departments} selectedDeptIds={localDeptIds} onDeptIdsChange={setLocalDeptIds}
            />
          </div>
        )}

        {departments && departments.length > 0 && (
          <div className="pt-2 border-t border-zinc-100">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-zinc-400">通知部门（创建待确认需求）</p>
              <button type="button"
                onClick={() => setNotifyDeptIds(
                  notifyDeptIds.length === departments.length ? [] : departments.map(d => d.id)
                )}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >{notifyDeptIds.length === departments.length ? "取消全选" : "全选"}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {departments.map(d => (
                <button key={d.id} type="button"
                  onClick={() => setNotifyDeptIds(prev =>
                    prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id]
                  )}
                  className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                    notifyDeptIds.includes(d.id)
                      ? "bg-zinc-800 text-white border-zinc-800"
                      : "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400"
                  }`}
                >{d.name}</button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={save} disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium disabled:opacity-50">
            {saving ? "…" : "保存"}
          </button>
          <button onClick={cancel} className="text-sm text-zinc-500">取消</button>
          <button onClick={onDelete} className="ml-auto text-sm text-red-400 hover:text-red-600">删除</button>
        </div>
      </div>
    );
  }

  const deptMap = new Map((departments ?? []).map(d => [d.id, d]));

  return (
    <div className="rounded-xl bg-white shadow-sm px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-zinc-800 truncate">{item.title}</span>
          <span className="shrink-0 text-[11px] rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">
            {SCHEDULE_ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
          </span>
          {(item.departmentIds ?? []).map(id => {
            const d = deptMap.get(id);
            return d ? (
              <span key={id} className="shrink-0 text-[11px] rounded bg-blue-50 px-1.5 py-0.5 text-blue-500">
                {d.name}
              </span>
            ) : null;
          })}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-xs text-zinc-400">
          {item.startTime && <span>{fmtTime(item.startTime)}{item.endTime ? ` — ${fmtTime(item.endTime)}` : ""}</span>}
          {item.location && <span>{item.location}</span>}
          {item.participants.length > 0 && (
            <span>{item.participants.map(p => p.name).join("、")}</span>
          )}
        </div>
      </div>
      {canEdit && (
        <button onClick={onEdit} className="text-xs text-zinc-400 hover:text-zinc-600 shrink-0">编辑</button>
      )}
    </div>
  );
}

// ─── ScheduleTableView ───────────────────────────────────────────────────────

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

type ModalState =
  | { mode: "edit"; item: EventScheduleItemWithParticipants }
  | { mode: "new"; startTime: string | null; deptId: string | null };

function ScheduleItemModal({
  state, eventId, productionId, items, onItemsChange, canAssignPeople,
  members, departments, singleDay, eventDate, eventStart, eventEnd,
  onTechReqsCreated, versionId, onClose,
}: {
  state: ModalState;
  eventId: string; productionId: string;
  items: EventScheduleItemWithParticipants[];
  onItemsChange: (items: EventScheduleItemWithParticipants[]) => void;
  canAssignPeople: boolean;
  members: MemberWithRoles[];
  departments: EventDepartment[];
  singleDay: boolean; eventDate: string;
  eventStart: string | null; eventEnd: string | null;
  onTechReqsCreated?: (reqs: EventTechReq[]) => void;
  versionId: string | null;
  onClose: () => void;
}) {
  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule`;
  const minAttr = eventStart ? toLocalInput(eventStart) : undefined;
  const maxAttr = eventEnd ? toLocalInput(eventEnd) : undefined;

  const isEdit = state.mode === "edit";
  const existing = isEdit ? state.item : null;

  const defaultStartStr = !isEdit && state.startTime
    ? (singleDay ? isoToTimeInput(state.startTime) : isoToDatetimeLocal(state.startTime))
    : (existing ? (singleDay ? isoToTimeInput(existing.startTime) : isoToDatetimeLocal(existing.startTime)) : "");
  const defaultEndStr = existing
    ? (singleDay ? isoToTimeInput(existing.endTime) : isoToDatetimeLocal(existing.endTime))
    : "";
  const defaultDeptIds = !isEdit && state.deptId
    ? [state.deptId]
    : (existing?.departmentIds ?? []);

  const [title, setTitle] = useState(existing?.title ?? "");
  const [itemType, setItemType] = useState(existing?.itemType ?? "custom");
  const [startVal, setStartVal] = useState(defaultStartStr);
  const [endVal, setEndVal] = useState(defaultEndStr);
  const [location, setLocation] = useState(existing?.location ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [deptIds, setDeptIds] = useState<string[]>(defaultDeptIds);
  const [participants, setParticipants] = useState<ScheduleItemParticipant[]>(existing?.participants ?? []);
  const [saving, setSaving] = useState(false);
  const [notifyDepts, setNotifyDepts] = useState<string[]>([]);

  function resolveTime(val: string): string | null {
    if (!val) return null;
    return datetimeLocalToIso(singleDay && eventDate ? `${eventDate}T${val}` : val);
  }

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      if (isEdit && existing) {
        const res = await fetch(`${base}/${existing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(), itemType,
            startTime: resolveTime(startVal), endTime: resolveTime(endVal),
            location: location.trim(), notes: notes.trim(),
            departmentIds: deptIds,
          }),
        });
        const data = await res.json();
        if (!data.item) return;
        if (canAssignPeople) {
          await fetch(`${base}/${existing.id}/participants`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participants }),
          });
        }
        onItemsChange(items.map(i => i.id === existing.id
          ? { ...data.item, participants, departmentIds: deptIds } : i));
      } else {
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(), itemType,
            startTime: resolveTime(startVal), endTime: resolveTime(endVal),
            location: location.trim(), notes: notes.trim(),
            orderIndex: items.length,
            departmentIds: deptIds,
          }),
        });
        const data = await res.json();
        if (!data.item) return;
        const newId: string = data.item.id;
        let savedParticipants: ScheduleItemParticipant[] = [];
        if (canAssignPeople && participants.length > 0) {
          await fetch(`${base}/${newId}/participants`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participants }),
          });
          savedParticipants = participants;
        }
        if (notifyDepts.length > 0) {
          const awRes = await fetch(
            `${BASE_PATH}/api/production/${productionId}/events/${eventId}/awaiting-reqs`,
            { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ departmentIds: notifyDepts, scheduleItemId: newId }) }
          );
          if (awRes.ok && onTechReqsCreated) {
            const awData = await awRes.json() as { techReqs: EventTechReq[] };
            onTechReqsCreated(awData.techReqs);
          }
        }
        onItemsChange([...items, { ...data.item, participants: savedParticipants, departmentIds: deptIds }]);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    await fetch(`${base}/${existing.id}`, { method: "DELETE" });
    onItemsChange(items.filter(i => i.id !== existing.id));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 flex flex-col gap-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-800">{isEdit ? "编辑流程项" : "添加流程项"}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-lg leading-none">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <input placeholder="流程标题 *" value={title} onChange={e => setTitle(e.target.value)}
            className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          <select value={itemType} onChange={e => setItemType(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
            {Object.entries(SCHEDULE_ITEM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input placeholder="地点" value={location} onChange={e => setLocation(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          {singleDay ? (
            <>
              <input type="time" value={startVal} onChange={e => setStartVal(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <input type="time" value={endVal} onChange={e => setEndVal(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </>
          ) : (
            <>
              <input type="datetime-local" value={startVal} min={minAttr} max={maxAttr} onChange={e => setStartVal(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <input type="datetime-local" value={endVal} min={minAttr} max={maxAttr} onChange={e => setEndVal(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </>
          )}
          <SmartTextarea placeholder="备注" value={notes} onChange={setNotes} rows={2}
            plugins={[scriptRefDropPlugin(productionId, versionId)]}
            className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
        </div>

        {canAssignPeople && members.length > 0 && (
          <div className="pt-2 border-t border-zinc-100">
            <p className="text-xs text-zinc-400 mb-2">参与人员</p>
            <ParticipantPicker
              members={members} selected={participants} onChange={setParticipants}
              departments={departments} selectedDeptIds={deptIds} onDeptIdsChange={setDeptIds}
            />
          </div>
        )}

        {!isEdit && departments.length > 0 && (
          <div className="pt-2 border-t border-zinc-100">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-zinc-400">通知部门（创建待确认需求）</p>
              <button type="button"
                onClick={() => setNotifyDepts(notifyDepts.length === departments.length ? [] : departments.map(d => d.id))}
                className="text-xs text-zinc-400 hover:text-zinc-600">
                {notifyDepts.length === departments.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {departments.map(d => (
                <button key={d.id} type="button"
                  onClick={() => setNotifyDepts(prev => prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])}
                  className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                    notifyDepts.includes(d.id) ? "bg-zinc-800 text-white border-zinc-800" : "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400"
                  }`}>{d.name}</button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium disabled:opacity-50">
            {saving ? "…" : isEdit ? "保存" : "添加"}
          </button>
          <button onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-700">取消</button>
          {isEdit && (
            <button onClick={remove} className="ml-auto text-sm text-red-400 hover:text-red-600">删除</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ScheduleTableView({
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
            coveredDeptIds.flatMap(id => departments.find(d => d.id === id)?.memberOpenIds ?? [])
          );
          const relevantParticipants = showAllParticipants
            ? cell.item.participants
            : (cell.item.participants.filter(p => deptMemberSet!.has(p.openId)) || cell.item.participants);
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
                <span className="opacity-60 w-full mt-0.5 italic"><SmartText content={cell.item.notes} plugins={[scriptRefTextPlugin]} /></span>
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

// ─── CallTimeTab ──────────────────────────────────────────────────────────────

function computeSuggestedCallAt(
  openId: string,
  scheduleItems: EventScheduleItemWithParticipants[],
  techReqs: EventTechReq[],
  isStageManager: boolean,
): string | null {
  if (isStageManager) {
    const starts = scheduleItems.flatMap(i => i.startTime ? [new Date(i.startTime).getTime()] : []);
    if (starts.length === 0) return null;
    return new Date(Math.min(...starts) - 30 * 60_000).toISOString();
  }
  const times: number[] = [];
  for (const item of scheduleItems) {
    if (item.startTime && item.participants.some(p => p.openId === openId)) {
      times.push(new Date(item.startTime).getTime());
    }
  }
  for (const req of techReqs) {
    if (req.status === "awaiting") continue;
    if (!req.assignees.some(a => a.openId === openId)) continue;
    if (req.presetMinutes == null) continue;
    for (const itemId of req.scheduleItemIds) {
      const item = scheduleItems.find(i => i.id === itemId);
      if (item?.startTime) {
        times.push(new Date(item.startTime).getTime() - req.presetMinutes * 60_000);
      }
    }
  }
  if (times.length === 0) return null;
  return new Date(Math.min(...times) - 15 * 60_000).toISOString();
}

function CallTimeTab({
  eventId, productionId, callTimes, eventPeople, scheduleItems, techReqs, members,
  stageManagerOpenIds, canEdit, singleDay, eventDate,
  onCallTimesChange, versionId,
}: {
  eventId: string; productionId: string;
  callTimes: EventCallTime[];
  eventPeople: { openId: string; name: string }[];
  scheduleItems: EventScheduleItemWithParticipants[];
  techReqs: EventTechReq[];
  members: MemberWithRoles[];
  stageManagerOpenIds: Set<string>;
  canEdit: boolean;
  singleDay: boolean; eventDate: string;
  onCallTimesChange: (cts: EventCallTime[]) => void;
  versionId: string | null;
}) {
  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/call-times`;
  const callTimeMap = new Map(callTimes.map(ct => [ct.openId, ct]));

  async function saveCallTime(openId: string, name: string, callAt: string, notes: string) {
    const existing = callTimeMap.get(openId);
    if (existing) {
      const res = await fetch(`${base}/${existing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callAt: datetimeLocalToIso(callAt), notes }),
      });
      const data = await res.json();
      if (data.callTime) onCallTimesChange(callTimes.map(ct => ct.id === existing.id ? data.callTime : ct));
    } else {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openId, name, callAt: datetimeLocalToIso(callAt), notes }),
      });
      const data = await res.json();
      if (data.callTime) onCallTimesChange([...callTimes, data.callTime]);
    }
  }

  async function deleteCallTime(openId: string) {
    const existing = callTimeMap.get(openId);
    if (!existing) return;
    await fetch(`${base}/${existing.id}`, { method: "DELETE" });
    onCallTimesChange(callTimes.filter(ct => ct.id !== existing.id));
  }

  if (eventPeople.length === 0) {
    return <p className="text-sm text-zinc-400 text-center py-6">先在流程项中添加参与人员</p>;
  }

  const memberMap = new Map(members.map(m => [m.openId, m]));
  const roleOrder: string[] = [];
  const roleGroups = new Map<string, { openId: string; name: string }[]>();
  for (const person of eventPeople) {
    const role = memberMap.get(person.openId)?.roles[0] ?? "其他";
    if (!roleGroups.has(role)) { roleGroups.set(role, []); roleOrder.push(role); }
    roleGroups.get(role)!.push(person);
  }

  return (
    <div className="flex flex-col gap-4">
      {roleOrder.map(role => (
        <div key={role}>
          <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-2">{role}</p>
          <div className="flex flex-col gap-2">
            {roleGroups.get(role)!.map(person => {
              const suggested = computeSuggestedCallAt(person.openId, scheduleItems, techReqs, stageManagerOpenIds.has(person.openId));
              return (
                <PersonCallTimeRow
                  key={person.openId}
                  person={person}
                  callTime={callTimeMap.get(person.openId) ?? null}
                  suggestedCallAt={suggested}
                  canEdit={canEdit}
                  singleDay={singleDay} eventDate={eventDate}
                  productionId={productionId}
                  versionId={versionId}
                  onSave={(callAt, notes) => saveCallTime(person.openId, person.name, callAt, notes)}
                  onDelete={() => deleteCallTime(person.openId)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PersonCallTimeRow({
  person, callTime, suggestedCallAt, canEdit, singleDay, eventDate, productionId, versionId, onSave, onDelete,
}: {
  person: { openId: string; name: string };
  callTime: EventCallTime | null;
  suggestedCallAt: string | null;
  canEdit: boolean;
  singleDay: boolean; eventDate: string;
  productionId: string;
  versionId: string | null;
  onSave: (callAt: string, notes: string) => void;
  onDelete: () => void;
}) {
  const suggestedLocal = singleDay ? toLocalTimeInput(suggestedCallAt) : toLocalInput(suggestedCallAt);
  const [editing, setEditing] = useState(false);
  const [callAt, setCallAt] = useState(
    singleDay ? toLocalTimeInput(callTime?.callAt ?? null) : toLocalInput(callTime?.callAt ?? null)
  );
  const [notes, setNotes] = useState(callTime?.notes ?? "");

  function resolveCallAt(val: string): string {
    return singleDay && eventDate ? `${eventDate}T${val}` : val;
  }

  const isLate = callTime && suggestedCallAt
    ? new Date(callTime.callAt) > new Date(suggestedCallAt)
    : false;

  function save() {
    if (!callAt) return;
    onSave(resolveCallAt(callAt), notes);
    setEditing(false);
  }

  function startEdit() {
    const base = callTime?.callAt ?? suggestedCallAt;
    setCallAt(singleDay ? toLocalTimeInput(base) : toLocalInput(base));
    setNotes(callTime?.notes ?? "");
    setEditing(true);
  }

  if (editing && canEdit) {
    const editIsLate = callAt && suggestedCallAt
      ? new Date(resolveCallAt(callAt) + "+08:00") > new Date(suggestedCallAt)
      : false;
    return (
      <div className="rounded-xl bg-white shadow-sm px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-zinc-800 w-20 shrink-0">{person.name}</span>
          <input
            type={singleDay ? "time" : "datetime-local"}
            value={callAt} onChange={e => setCallAt(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm focus:outline-none focus:border-zinc-400 flex-1"
          />
          <button onClick={save} className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-xs font-medium">设置</button>
          <button onClick={() => setEditing(false)} className="text-xs text-zinc-400">取消</button>
          {callTime && (
            <button onClick={() => { onDelete(); setEditing(false); }} className="text-xs text-red-400">删除</button>
          )}
        </div>
        <SmartTextarea
          placeholder="备注（可选）"
          value={notes} onChange={setNotes}
          rows={2}
          plugins={[scriptRefDropPlugin(productionId, versionId)]}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none w-full"
        />
        {editIsLate && suggestedLocal && (
          <p className="text-xs text-amber-600">
            ⚠ 建议不晚于 {suggestedLocal}（最早需要到场时间提前 15 分钟）
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white shadow-sm px-4 py-3 flex items-center gap-3">
      <span className="text-sm font-medium text-zinc-800 flex-1">{person.name}</span>
      {callTime ? (
        <>
          <span className={`text-sm font-semibold ${isLate ? "text-amber-500" : "text-zinc-700"}`}>
            {fmtTime(callTime.callAt)}
          </span>
          {isLate && <span className="text-xs text-amber-500">⚠ 偏晚</span>}
          {callTime.notes && <span className="text-xs text-zinc-400"><SmartText content={callTime.notes} plugins={[scriptRefTextPlugin]} /></span>}
          {canEdit && <button onClick={startEdit} className="text-xs text-zinc-400 hover:text-zinc-600">编辑</button>}
        </>
      ) : (
        canEdit
          ? <button onClick={startEdit} className="text-xs text-zinc-400 hover:text-zinc-600 border border-dashed border-zinc-200 rounded px-2 py-0.5">
              {suggestedLocal ? `建议 ${fmtTime(suggestedCallAt!)}` : "+ 设置时间"}
            </button>
          : <span className="text-xs text-zinc-300">—</span>
      )}
    </div>
  );
}

// ─── TechReqTab ───────────────────────────────────────────────────────────────

function ScheduleItemPicker({
  items, selected, onChange,
}: {
  items: EventScheduleItemWithParticipants[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  function toggle(id: string) {
    onChange(selectedSet.has(id) ? selected.filter(x => x !== id) : [...selected, id]);
  }
  if (items.length === 0) return <p className="text-xs text-zinc-400">暂无流程项</p>;
  const sorted = [...items].sort((a, b) => {
    if (!a.startTime && !b.startTime) return 0;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });
  return (
    <div className="flex flex-col gap-1">
      {sorted.map(item => {
        const isSelected = selectedSet.has(item.id);
        return (
          <button key={item.id} onClick={() => toggle(item.id)}
            className={`text-left rounded-lg px-3 py-2 text-sm transition-colors ${
              isSelected ? "bg-zinc-800 text-white" : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
            }`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{item.title}</span>
              {isSelected && <span className="shrink-0 text-[10px] opacity-50">×</span>}
            </div>
            {item.startTime && (
              <p className={`text-[11px] mt-0.5 ${isSelected ? "text-zinc-300" : "text-zinc-400"}`}>
                {fmtTime(item.startTime)}{item.endTime ? ` — ${fmtTime(item.endTime)}` : ""}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TechReqCard({
  req, expanded, onToggleExpand,
  canEditThisReq, isEventClosed,
  scheduleItems, deptMembers, allMembers, base,
  productionId, versionId,
  onUpdate, onDelete, canDelete,
}: {
  req: EventTechReq;
  expanded: boolean;
  onToggleExpand: () => void;
  canEditThisReq: boolean;
  isEventClosed: boolean;
  scheduleItems: EventScheduleItemWithParticipants[];
  deptMembers: MemberWithRoles[];
  allMembers?: MemberWithRoles[];
  base: string;
  productionId: string;
  versionId: string | null;
  onUpdate: (req: EventTechReq) => void;
  onDelete: (id: string) => void;
  canDelete: boolean;
}) {
  const [editTitle, setEditTitle] = useState(req.title);
  const [editDesc, setEditDesc] = useState(req.description ?? "");
  const [editPreset, setEditPreset] = useState(req.presetMinutes?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  const editable = canEditThisReq && !isEventClosed;
  const hasBasicChanges = editTitle !== req.title
    || editDesc !== (req.description ?? "")
    || editPreset !== (req.presetMinutes?.toString() ?? "");

  async function saveBasic() {
    setSaving(true);
    try {
      const res = await fetch(`${base}/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDesc.trim(),
          presetMinutes: editPreset ? parseInt(editPreset) : null,
        }),
      });
      const data = await res.json();
      if (data.techReq) {
        onUpdate(data.techReq);
        setEditTitle(data.techReq.title);
        setEditDesc(data.techReq.description ?? "");
        setEditPreset(data.techReq.presetMinutes?.toString() ?? "");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleItemsChange(ids: string[]) {
    const res = await fetch(`${base}/${req.id}/items`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIds: ids }),
    });
    const data = await res.json();
    if (data.techReq) onUpdate(data.techReq);
  }

  async function handleAssigneesChange(assignees: { openId: string; name: string }[]) {
    const res = await fetch(`${base}/${req.id}/assignees`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignees }),
    });
    const data = await res.json();
    if (data.techReq) onUpdate(data.techReq);
  }

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 cursor-pointer" onClick={onToggleExpand}>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-zinc-800 truncate block">{req.title}</span>
          {req.assignees.length > 0 && (
            <span className="text-xs text-zinc-400">负责: {req.assignees.map(a => a.name).join(", ")}</span>
          )}
        </div>
        <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${TECH_STATUS_COLORS[req.status] ?? "bg-zinc-100 text-zinc-500"}`}>
          {TECH_STATUS_LABELS[req.status] ?? req.status}
        </span>
        <span className="text-zinc-300 text-sm">{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-zinc-100">
          {editable ? (
            <>
              <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 mt-2" />
              <SmartTextarea value={editDesc} onChange={setEditDesc} rows={2}
                placeholder="描述（可选）"
                plugins={[scriptRefDropPlugin(productionId, versionId)]}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400 shrink-0">提前分钟</span>
                <input type="number" value={editPreset} onChange={e => setEditPreset(e.target.value)}
                  placeholder="可选"
                  className="w-24 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              </div>
              {hasBasicChanges && (
                <button onClick={saveBasic} disabled={saving || !editTitle.trim()}
                  className="self-start px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-xs font-medium hover:bg-zinc-700 disabled:opacity-50">
                  {saving ? "保存中…" : "保存"}
                </button>
              )}
            </>
          ) : (
            <>
              {req.description && <p className="text-sm text-zinc-600 pt-2"><SmartText content={req.description} plugins={[scriptRefTextPlugin]} /></p>}
              {req.presetMinutes != null && (
                <p className="text-xs text-zinc-400">提前 {req.presetMinutes} 分钟准备</p>
              )}
            </>
          )}
          {scheduleItems.length > 0 && (
            <div>
              <p className="text-xs text-zinc-400 mb-2">绑定流程项</p>
              {editable ? (
                <ScheduleItemPicker
                  items={scheduleItems}
                  selected={req.scheduleItemIds}
                  onChange={handleItemsChange}
                />
              ) : (
                req.scheduleItemIds.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {req.scheduleItemIds.map(id => {
                      const item = scheduleItems.find(i => i.id === id);
                      return item ? (
                        <span key={id} className="text-xs bg-zinc-100 text-zinc-600 rounded px-2 py-1">{item.title}</span>
                      ) : null;
                    })}
                  </div>
                ) : <p className="text-xs text-zinc-400">未绑定流程项</p>
              )}
            </div>
          )}
          <AssigneeEditor
            req={req}
            members={deptMembers}
            allMembers={allMembers}
            canEdit={editable}
            onSave={handleAssigneesChange}
          />
          {canDelete && (
            <button onClick={() => onDelete(req.id)}
              className="self-start text-xs text-red-400 hover:text-red-600">删除需求</button>
          )}
        </div>
      )}
    </div>
  );
}

function TechReqTab({
  eventId, productionId, techReqs, departments, members, scheduleItems, canEdit, canDelete,
  pocDeptIds, eventStatus, onTechReqsChange, versionId,
}: {
  eventId: string; productionId: string;
  techReqs: EventTechReq[]; departments: EventDepartment[]; members: MemberWithRoles[];
  scheduleItems: EventScheduleItemWithParticipants[];
  canEdit: boolean; canDelete: boolean;
  pocDeptIds: string[];
  eventStatus: string;
  onTechReqsChange: (reqs: EventTechReq[]) => void;
  versionId: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDeptId, setNewDeptId] = useState("");
  const [newPreset, setNewPreset] = useState("");
  const [newAssignees, setNewAssignees] = useState<{ openId: string; name: string }[]>([]);
  const [newItemIds, setNewItemIds] = useState<string[]>([]);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/tech-reqs`;

  function canEditReq(deptId: string | null) {
    if (canEdit) return true;
    if (deptId && pocDeptIds.includes(deptId)) return true;
    return false;
  }

  async function addReq() {
    if (!newTitle.trim()) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newTitle.trim(), description: newDesc.trim(),
        departmentId: newDeptId || null,
        presetMinutes: newPreset ? parseInt(newPreset) : null,
        scheduleItemIds: newItemIds,
        assignees: newAssignees,
      }),
    });
    const data = await res.json();
    if (!data.techReq) return;
    onTechReqsChange([...techReqs, data.techReq]);
    setNewTitle(""); setNewDesc(""); setNewDeptId(""); setNewPreset("");
    setNewAssignees([]); setNewItemIds([]);
    setAdding(false);
  }

  async function deleteReq(id: string) {
    await fetch(`${base}/${id}`, { method: "DELETE" });
    onTechReqsChange(techReqs.filter(r => r.id !== id));
  }

  function handleUpdate(updated: EventTechReq) {
    onTechReqsChange(techReqs.map(r => r.id === updated.id ? updated : r));
  }

  const grouped = new Map<string, EventTechReq[]>();
  const noDept: EventTechReq[] = [];
  for (const r of techReqs) {
    if (r.departmentId) {
      if (!grouped.has(r.departmentId)) grouped.set(r.departmentId, []);
      grouped.get(r.departmentId)!.push(r);
    } else {
      noDept.push(r);
    }
  }

  function deptMembers(deptId: string | null): MemberWithRoles[] {
    if (!deptId) return members;
    const dept = departments.find(d => d.id === deptId);
    if (!dept) return members;
    const set = new Set([...dept.memberOpenIds, ...dept.pocOpenIds]);
    return members.filter(m => set.has(m.openId));
  }

  const isEventClosed = eventStatus === "completed" || eventStatus === "cancelled";

  function renderCard(req: EventTechReq) {
    return (
      <TechReqCard
        key={req.id}
        req={req}
        expanded={expandedId === req.id}
        onToggleExpand={() => setExpandedId(expandedId === req.id ? null : req.id)}
        canEditThisReq={canEditReq(req.departmentId)}
        isEventClosed={isEventClosed}
        scheduleItems={scheduleItems}
        deptMembers={deptMembers(req.departmentId)}
        allMembers={req.departmentId ? members : undefined}
        base={base}
        productionId={productionId}
        versionId={versionId}
        onUpdate={handleUpdate}
        onDelete={deleteReq}
        canDelete={canDelete}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {techReqs.length === 0 && !adding && (
        <p className="text-sm text-zinc-400 text-center py-6">暂无技术需求</p>
      )}

      {[...grouped.entries()].map(([deptId, reqs]) => {
        const dept = departments.find(d => d.id === deptId);
        return (
          <div key={deptId}>
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">
              {dept?.name ?? "未知部门"}
            </p>
            <div className="flex flex-col gap-2">{reqs.map(renderCard)}</div>
          </div>
        );
      })}

      {noDept.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">未分配部门</p>
          <div className="flex flex-col gap-2">{noDept.map(renderCard)}</div>
        </div>
      )}

      {(canEdit || pocDeptIds.length > 0) && (
        adding ? (
          <div className="rounded-xl bg-white shadow-sm p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="需求标题 *" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <SmartTextarea value={newDesc} onChange={setNewDesc} plugins={[scriptRefDropPlugin(productionId, versionId)]} rows={2} placeholder="描述"
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
              <select value={newDeptId} onChange={e => {
                  const next = e.target.value;
                  setNewDeptId(next);
                  if (next) {
                    const dept = departments.find(d => d.id === next);
                    const set = new Set(dept?.memberOpenIds ?? []);
                    setNewAssignees(prev => prev.filter(a => set.has(a.openId)));
                  }
                }}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                <option value="">无部门</option>
                {departments
                  .filter(d => canEdit || pocDeptIds.includes(d.id))
                  .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <input type="number" placeholder="提前分钟（可选）" value={newPreset} onChange={e => setNewPreset(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
            </div>
            {scheduleItems.length > 0 && (
              <div className="pt-2 border-t border-zinc-100">
                <p className="text-xs text-zinc-400 mb-2">绑定流程项</p>
                <ScheduleItemPicker items={scheduleItems} selected={newItemIds} onChange={setNewItemIds} />
              </div>
            )}
            {members.length > 0 && (
              <div className="pt-2 border-t border-zinc-100">
                <p className="text-xs text-zinc-400 mb-2">负责人</p>
                <AssigneeEditorInline
                  members={deptMembers(newDeptId || null)}
                  allMembers={newDeptId ? members : undefined}
                  assignees={newAssignees}
                  onChange={setNewAssignees}
                />
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={addReq}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700">
                添加
              </button>
              <button onClick={() => { setAdding(false); setNewAssignees([]); setNewItemIds([]); }} className="text-sm text-zinc-500">取消</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors">
            + 添加技术需求
          </button>
        )
      )}
    </div>
  );
}

function AssigneeEditorInline({
  members, allMembers, assignees, onChange,
}: {
  members: MemberWithRoles[];
  allMembers?: MemberWithRoles[];
  assignees: { openId: string; name: string }[];
  onChange: (next: { openId: string; name: string }[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const selected = new Set(assignees.map(a => a.openId));

  const hasOutside = !!allMembers && allMembers.length > members.length;
  const pool = showAll && hasOutside ? allMembers! : members;

  const filtered = pool.filter(m =>
    !search || m.name.includes(search) || m.roles.some(r => r.includes(search))
  );
  function toggle(m: MemberWithRoles) {
    onChange(selected.has(m.openId)
      ? assignees.filter(a => a.openId !== m.openId)
      : [...assignees, { openId: m.openId, name: m.name }]);
  }
  const groups = groupByRole(filtered);
  return (
    <div className="flex flex-col gap-2">
      <input placeholder="搜索姓名或职位…" value={search} onChange={e => setSearch(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
      {hasOutside && (
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="rounded" />
          <span className="text-xs text-zinc-500">显示全部成员</span>
        </label>
      )}
      {filtered.length === 0 && <p className="text-xs text-zinc-400">无匹配成员</p>}
      <div className="max-h-64 overflow-y-auto flex flex-col gap-3">
        {groups.map(({ role, members: gm }) => (
          <div key={role}>
            <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-1.5">{role}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {gm.map(m => (
                <MemberCard key={m.openId} m={m} isSelected={selected.has(m.openId)} onToggle={() => toggle(m)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssigneeEditor({
  req, members, allMembers, canEdit, onSave,
}: {
  req: EventTechReq; members: MemberWithRoles[];
  allMembers?: MemberWithRoles[];
  canEdit: boolean; onSave: (assignees: { openId: string; name: string }[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const assigneeSet = new Set(req.assignees.map(a => a.openId));

  const hasOutside = !!allMembers && allMembers.length > members.length;
  const pool = showAll && hasOutside ? allMembers! : members;

  function toggle(m: MemberWithRoles) {
    const next = assigneeSet.has(m.openId)
      ? req.assignees.filter(a => a.openId !== m.openId)
      : [...req.assignees, { openId: m.openId, name: m.name }];
    onSave(next);
  }

  if (!canEdit) {
    return req.assignees.length > 0 ? (
      <p className="text-xs text-zinc-400">负责人: {req.assignees.map(a => a.name).join(", ")}</p>
    ) : null;
  }

  const filtered = pool.filter(m =>
    !search || m.name.includes(search) || m.roles.some(r => r.includes(search))
  );
  const groups = groupByRole(filtered);

  return (
    <div>
      <button onClick={() => setEditing(!editing)} className="text-xs text-zinc-500 hover:text-zinc-700 mb-2">
        {editing ? "▲ 收起" : "▼ 编辑负责人"}
      </button>
      {editing && (
        <div className="flex flex-col gap-2">
          <input placeholder="搜索姓名或职位…" value={search} onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
          {hasOutside && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="rounded" />
              <span className="text-xs text-zinc-500">显示全部成员</span>
            </label>
          )}
          {filtered.length === 0 && <p className="text-xs text-zinc-400">无匹配成员</p>}
          <div className="max-h-64 overflow-y-auto flex flex-col gap-3">
            {groups.map(({ role, members: gm }) => (
              <div key={role}>
                <p className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-1.5">{role}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {gm.map(m => (
                    <MemberCard key={m.openId} m={m} isSelected={assigneeSet.has(m.openId)} onToggle={() => toggle(m)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ReportsTab ───────────────────────────────────────────────────────────────

function ReportsTab({
  eventId, productionId, reports, departments, members, canWrite,
  currentUserOpenId, onReportsChange, versionId,
}: {
  eventId: string; productionId: string;
  reports: EventReport[]; departments: EventDepartment[];
  members: MentionMember[];
  canWrite: boolean;
  currentUserOpenId: string;
  onReportsChange: (rs: EventReport[]) => void;
  versionId: string | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("rehearsal");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports`;

  async function saveRename(id: string) {
    if (!renameTitle.trim()) return;
    setRenaming(true);
    try {
      const res = await fetch(`${base}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: renameTitle.trim() }),
      });
      const data = await res.json();
      if (data.report) {
        onReportsChange(reports.map(r => r.id === id ? data.report : r));
        setRenameId(null);
      }
    } finally {
      setRenaming(false);
    }
  }

  async function createReport() {
    if (!newTitle.trim()) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim(), reportType: newType }),
    });
    const data = await res.json();
    if (data.report) {
      onReportsChange([...reports, data.report]);
      setNewTitle(""); setNewType("rehearsal"); setAdding(false);
    }
  }

  async function deleteReport(id: string) {
    await fetch(`${base}/${id}`, { method: "DELETE" });
    onReportsChange(reports.filter(r => r.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {reports.length === 0 && !adding && (
        <p className="text-sm text-zinc-400 text-center py-6">暂无记录</p>
      )}

      {reports.map(report => (
        <div key={report.id} className="rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 flex items-center gap-3 cursor-pointer"
            onClick={() => { if (renameId !== report.id) setExpandedId(expandedId === report.id ? null : report.id); }}>
            <div className="flex-1 min-w-0">
              {renameId === report.id ? (
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <input
                    value={renameTitle}
                    onChange={e => setRenameTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveRename(report.id); if (e.key === "Escape") setRenameId(null); }}
                    autoFocus
                    className="flex-1 min-w-0 rounded border border-zinc-200 px-2 py-1 text-sm focus:outline-none focus:border-zinc-400"
                  />
                  <button onClick={() => saveRename(report.id)} disabled={renaming}
                    className="shrink-0 text-[11px] text-blue-500 hover:text-blue-700 disabled:opacity-50">
                    {renaming ? "…" : "保存"}
                  </button>
                  <button onClick={() => setRenameId(null)}
                    className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600">
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium text-zinc-800 truncate block">{report.title}</span>
                  <span className="text-xs text-zinc-400">
                    {fmt(report.createdAt)} · {report.publishedAt ? "已发布" : "草稿"}
                  </span>
                </>
              )}
            </div>
            <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 font-medium ${report.publishedAt ? "bg-green-50 text-green-600" : "bg-zinc-100 text-zinc-500"}`}>
              {report.publishedAt ? "已发布" : "草稿"}
            </span>
            {canWrite && renameId !== report.id && (
              <button
                onClick={e => { e.stopPropagation(); setRenameId(report.id); setRenameTitle(report.title); }}
                className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600 px-1"
              >
                改名
              </button>
            )}
            <Link
              href={`/production/${productionId}/events/${eventId}/reports/${report.id}`}
              onClick={e => e.stopPropagation()}
              className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600 px-1"
            >
              查看
            </Link>
            <span className="text-zinc-300 text-sm">{expandedId === report.id ? "▲" : "▼"}</span>
          </div>

          {expandedId === report.id && (
            <ReportEditor
              report={report} departments={departments}
              eventId={eventId} productionId={productionId}
              members={members}
              canWrite={canWrite}
              currentUserOpenId={currentUserOpenId}
              versionId={versionId}
              onUpdated={updated => onReportsChange(reports.map(r => r.id === updated.id ? updated : r))}
              onDelete={() => deleteReport(report.id)}
            />
          )}
        </div>
      ))}

      {canWrite && (
        adding ? (
          <div className="rounded-xl bg-white shadow-sm p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="记录标题 *" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <select value={newType} onChange={e => setNewType(e.target.value)}
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                <option value="rehearsal">排练记录</option>
                <option value="performance">演出记录</option>
                <option value="meeting">会议纪要</option>
                <option value="custom">其他</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={createReport}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium">创建</button>
              <button onClick={() => setAdding(false)} className="text-sm text-zinc-500">取消</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors">
            + 新建记录
          </button>
        )
      )}
    </div>
  );
}

function ReportEditor({
  report, departments, eventId, productionId, members, canWrite,
  currentUserOpenId, versionId,
  onUpdated, onDelete,
}: {
  report: EventReport; departments: EventDepartment[];
  eventId: string; productionId: string;
  members: MentionMember[];
  canWrite: boolean;
  currentUserOpenId: string;
  versionId: string | null;
  onUpdated: (r: EventReport) => void; onDelete: () => void;
}) {
  const [body, setBody] = useState(report.body);
  const [mentions, setMentions] = useState(report.mentions);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports`;
  const isPublished = !!report.publishedAt;

  async function saveBody() {
    setSaving(true);
    const res = await fetch(`${base}/${report.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, mentions }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.report) onUpdated(data.report);
  }

  return (
    <div className="px-4 pb-4 border-t border-zinc-100 flex flex-col gap-4 pt-3">
      {/* Body: editable only when canWrite and not yet published */}
      {canWrite && !isPublished ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-zinc-400">正文</label>
          <MarkdownEditor
            content={body}
            onChange={setBody}
            onMentionsChange={setMentions}
            members={members}
            productionId={productionId}
            placeholder="写报告正文… 输入 @ 可提及成员，# 可引用剧本位置"
            minHeight={200}
          />
          <div className="flex gap-2 flex-wrap items-center">
            <button onClick={saveBody} disabled={saving || body === report.body}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium disabled:opacity-50">
              {saving ? "…" : "保存"}
            </button>
            {confirmDelete ? (
              <span className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-red-500">确认？</span>
                <button onClick={onDelete} className="px-2 py-1 text-xs bg-red-500 text-white rounded-lg">删除</button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400">取消</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="ml-auto text-xs text-red-400 hover:text-red-600">
                删除记录
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {report.body
            ? <MarkdownView content={report.body} />
            : <p className="text-xs text-zinc-300">暂无正文</p>
          }
          {canWrite && !isPublished && (
            <div className="flex gap-2 mt-1">
              {confirmDelete ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-red-500">确认？</span>
                  <button onClick={onDelete} className="px-2 py-1 text-xs bg-red-500 text-white rounded-lg">删除</button>
                  <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400">取消</button>
                </span>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="text-xs text-red-400 hover:text-red-600">
                  删除记录
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <DeptNotesList
        reportId={report.id} eventId={eventId} productionId={productionId}
        departments={departments.filter(d => d.kind === "dept")}
        members={members}
        currentUserOpenId={currentUserOpenId}
        isPublished={isPublished}
        versionId={versionId}
      />
    </div>
  );
}

function DeptNotesList({
  reportId, eventId, productionId, departments, members,
  currentUserOpenId, isPublished, versionId,
}: {
  reportId: string; eventId: string; productionId: string;
  departments: EventDepartment[];
  members: MentionMember[];
  currentUserOpenId: string;
  isPublished: boolean;
  versionId: string | null;
}) {
  const [notes, setNotes] = useState<EventReportNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editMentions, setEditMentions] = useState<MentionMember[]>([]);
  const [newDeptId, setNewDeptId] = useState(departments[0]?.id ?? "");
  const [newContent, setNewContent] = useState("");
  const [newMentions, setNewMentions] = useState<MentionMember[]>([]);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports/${reportId}/notes`;

  async function load() {
    const res = await fetch(base);
    const data = await res.json();
    if (data.notes) { setNotes(data.notes); setLoaded(true); }
  }

  async function addNote() {
    if (!newContent.trim() || !newDeptId) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ departmentId: newDeptId, content: newContent.trim(), mentions: newMentions }),
    });
    const data = await res.json();
    if (data.note) { setNotes(prev => [...prev, data.note]); setNewContent(""); setNewMentions([]); }
  }

  async function saveEdit(id: string) {
    if (!editDraft.trim()) return;
    const res = await fetch(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editDraft.trim(), mentions: editMentions }),
    });
    const data = await res.json();
    if (data.note) { setNotes(prev => prev.map(n => n.id === id ? data.note : n)); setEditingId(null); }
  }

  async function deleteNote(id: string) {
    await fetch(`${base}/${id}`, { method: "DELETE" });
    setNotes(prev => prev.filter(n => n.id !== id));
  }

  if (!loaded) {
    return (
      <button onClick={load} className="text-xs text-zinc-400 hover:text-zinc-600">
        ▼ 查看部门 Notes
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">部门 Notes</p>
      {notes.length === 0 && <p className="text-xs text-zinc-300 text-center py-2">暂无 Notes</p>}
      {notes.map(note => {
        const dept = departments.find(d => d.id === note.departmentId);
        const isOwn = note.authorOpenId === currentUserOpenId;
        return (
          <div key={note.id} className="rounded-lg bg-zinc-50 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                {dept && <span className="text-[11px] font-medium text-zinc-500">{dept.name}</span>}
                <span className="text-[11px] text-zinc-400">{note.authorName}</span>
              </div>
              {!isPublished && (
                <div className="flex gap-2 shrink-0">
                  {isOwn && (
                    <button onClick={() => {
                      setEditingId(editingId === note.id ? null : note.id);
                      setEditDraft(note.content);
                      setEditMentions(note.mentions ?? []);
                    }} className="text-[11px] text-zinc-400 hover:text-zinc-600">
                      {editingId === note.id ? "取消" : "编辑"}
                    </button>
                  )}
                  <button onClick={() => deleteNote(note.id)} className="text-xs text-zinc-300 hover:text-red-400">×</button>
                </div>
              )}
            </div>
            {editingId === note.id ? (
              <div className="flex flex-col gap-1.5">
                <SmartTextarea
                  value={editDraft}
                  onChange={setEditDraft}
                  plugins={[memberDropPlugin(members, { onPick: m => setEditMentions(prev => [...prev.filter(x => x.openId !== m.openId), m]) }), scriptRefDropPlugin(productionId, versionId)]}
                  rows={2}
                  placeholder="写 note…"
                  className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm focus:outline-none resize-none"
                />
                <button onClick={() => saveEdit(note.id)}
                  className="self-start px-2 py-1 text-xs rounded-lg bg-zinc-800 text-white">保存</button>
              </div>
            ) : (
              <SmartText content={note.content} plugins={[memberTextPlugin(note.mentions ?? []), scriptRefTextPlugin]} />
            )}
          </div>
        );
      })}
      {!isPublished && departments.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-1">
          <div className="flex gap-2">
            <select value={newDeptId} onChange={e => setNewDeptId(e.target.value)}
              className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs focus:outline-none shrink-0">
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button onClick={addNote}
              className="ml-auto px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-xs font-medium shrink-0">添加</button>
          </div>
          <SmartTextarea
            value={newContent}
            onChange={setNewContent}
            plugins={[memberDropPlugin(members, { onPick: m => setNewMentions(prev => [...prev.filter(x => x.openId !== m.openId), m]) }), scriptRefDropPlugin(productionId, versionId)]}
            rows={2}
            placeholder="写 note… 输入 @ 可提及成员"
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); } }}
            className="w-full rounded-lg border border-zinc-200 px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-400 resize-none"
          />
        </div>
      )}
    </div>
  );
}

// ─── EventChatSection ─────────────────────────────────────────────────────────

function EventChatSection({
  event, productionId, canEdit, onChatIdSet, onChatIdCleared,
}: {
  event: ProductionEvent;
  productionId: string;
  canEdit: boolean;
  onChatIdSet: (chatId: string) => void;
  onChatIdCleared: () => void;
}) {
  const [bindQuery, setBindQuery] = useState("");
  const [bindResults, setBindResults] = useState<{ chatId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBind, setShowBind] = useState(false);

  async function createChat() {
    if (!confirm("确定为此事件创建飞书群吗？")) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (data.chatId) onChatIdSet(data.chatId);
      else alert(data.error ?? "建群失败");
    } finally { setBusy(false); }
  }

  async function searchBindable() {
    if (!bindQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/chats/bindable?q=${encodeURIComponent(bindQuery)}`);
      const data = await res.json();
      setBindResults(data.chats ?? []);
    } finally { setSearching(false); }
  }

  async function bindChat(chatId: string) {
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind", chatId }),
      });
      const data = await res.json();
      if (data.chatId) { onChatIdSet(data.chatId); setShowBind(false); }
      else alert(data.error ?? "绑定失败");
    } finally { setBusy(false); }
  }

  async function unbindChat() {
    if (!confirm("确定解绑飞书群吗？群本身不会被删除。")) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/chat`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) onChatIdCleared();
      else alert(data.error ?? "解绑失败");
    } finally { setBusy(false); }
  }

  if (event.chatId) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">飞书群</span>
        <span className="text-xs bg-blue-50 text-blue-600 rounded-lg px-2 py-1 font-medium">已绑定</span>
        {canEdit && (
          <button onClick={unbindChat} disabled={busy}
            className="text-xs text-zinc-400 hover:text-red-500 disabled:opacity-50 underline">
            {busy ? "…" : "解绑"}
          </button>
        )}
      </div>
    );
  }

  if (!canEdit) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap">
        <button onClick={createChat} disabled={busy}
          className="px-3 py-1.5 rounded-lg border border-blue-200 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50">
          {busy ? "…" : "创建飞书群"}
        </button>
        <button onClick={() => setShowBind(b => !b)} disabled={busy}
          className="px-3 py-1.5 rounded-lg border border-zinc-200 text-sm text-zinc-600 hover:bg-zinc-50">
          绑定现有群
        </button>
      </div>
      {showBind && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input value={bindQuery} onChange={e => setBindQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && searchBindable()}
              placeholder="搜索群名…"
              className="flex-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-400" />
            <button onClick={searchBindable} disabled={searching}
              className="px-3 py-1.5 rounded-lg bg-zinc-100 text-sm text-zinc-600 hover:bg-zinc-200 disabled:opacity-50">
              {searching ? "…" : "搜索"}
            </button>
          </div>
          {bindResults !== null && (
            bindResults.length === 0
              ? <p className="text-xs text-zinc-400">未找到可绑定的群</p>
              : <div className="flex flex-col gap-1">
                  {bindResults.map(c => (
                    <button key={c.chatId} onClick={() => bindChat(c.chatId)} disabled={busy}
                      className="text-left rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 border border-zinc-100 disabled:opacity-50">
                      {c.name}
                    </button>
                  ))}
                </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PublishTab ───────────────────────────────────────────────────────────────

function ChecklistItem({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
        done ? "bg-green-100 text-green-600" : "bg-zinc-100 text-zinc-300"
      }`}>
        {done ? "✓" : "·"}
      </div>
      <span className={`text-sm ${done ? "text-zinc-700" : "text-zinc-400"}`}>{label}</span>
    </div>
  );
}

function PublishTab({
  event, productionId, scheduleItems, callTimes, eventPeople, techReqs, canEdit, onUpdated,
  onAllTechReqsCompleted,
}: {
  event: ProductionEvent; productionId: string;
  scheduleItems: EventScheduleItemWithParticipants[];
  callTimes: EventCallTime[];
  eventPeople: { openId: string; name: string }[];
  techReqs: EventTechReq[];
  canEdit: boolean;
  onUpdated: (ev: ProductionEvent) => void;
  onAllTechReqsCompleted?: () => void;
}) {
  const awaitingCount = techReqs.filter(r => r.status === "awaiting").length;
  const [urging, setUrging] = useState(false);

  async function urgeReqs() {
    setUrging(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/notify-awaiting-reqs`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.notified != null) alert(`已向 ${data.notified} 个部门群发送催确认通知`);
      else alert(data.error ?? "发送失败");
    } finally { setUrging(false); }
  }

  async function changeStatus(status: string) {
    if (status === "published" && awaitingCount > 0) {
      if (!confirm(`还有 ${awaitingCount} 个待确认需求未处理，确定要发布吗？`)) return;
    }
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (data.event) {
      onUpdated(data.event);
      if (status === "completed") onAllTechReqsCompleted?.();
    }
  }

  const callTimesNeeded = eventPeople.length;
  const callTimesSet = callTimes.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[event.status] ?? "bg-zinc-100 text-zinc-400"}`}>
          {STATUS_LABELS[event.status] ?? event.status}
        </span>
      </div>

      <EventChatSection
        event={event} productionId={productionId} canEdit={canEdit}
        onChatIdSet={chatId => onUpdated({ ...event, chatId })}
        onChatIdCleared={() => onUpdated({ ...event, chatId: null })}
      />

      <div className="flex flex-col gap-2.5">
        <ChecklistItem
          done={!!(event.startTime || event.endTime)}
          label="事件时间已设置"
        />
        <ChecklistItem
          done={scheduleItems.length > 0}
          label={`事件流程 · ${scheduleItems.length} 项`}
        />
        <ChecklistItem
          done={callTimesNeeded > 0 && callTimesSet >= callTimesNeeded}
          label={`Call Time · ${callTimesSet} / ${callTimesNeeded} 人`}
        />
        <div className="flex items-center gap-3">
          <ChecklistItem
            done={awaitingCount === 0}
            label={awaitingCount === 0 ? "技术需求已全部确认" : `${awaitingCount} 个技术需求待确认`}
          />
          {canEdit && awaitingCount > 0 && (
            <button onClick={urgeReqs} disabled={urging}
              className="px-2.5 py-1 rounded-lg border border-red-200 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50 shrink-0">
              {urging ? "…" : "催确认"}
            </button>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {event.status === "draft" && (
            <button onClick={() => changeStatus("published")}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
              发布
            </button>
          )}
          {event.status === "published" && (
            <>
              <button onClick={() => changeStatus("completed")}
                className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700">
                标记完成
              </button>
              <button onClick={() => changeStatus("draft")}
                className="px-4 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-600 hover:bg-zinc-50">
                撤回草稿
              </button>
            </>
          )}
          {event.status === "completed" && (
            <button onClick={() => changeStatus("draft")}
              className="px-4 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-600 hover:bg-zinc-50">
              重新开放
            </button>
          )}
          {event.status !== "cancelled" && (
            <button onClick={() => changeStatus("cancelled")}
              className="px-4 py-2 rounded-lg border border-red-200 text-sm text-red-500 hover:bg-red-50">
              取消事件
            </button>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const TABS = [
  { id: "info",           label: "基本信息" },
  { id: "schedule",       label: "事件流程" },
  { id: "tech",           label: "技术提需" },
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
  initialEventPeople: { openId: string; name: string }[];
  initialCallTimes: EventCallTime[];
  initialTechReqs: EventTechReq[];
  initialReports: EventReport[];
  departments: EventDepartment[];
  members: MemberWithRoles[];
  versions?: Version[];
  canEdit: boolean;
  canScheduleEdit: boolean;
  canAssignPeople: boolean;
  canCallEdit: boolean;
  canTechReqDelete: boolean;
  canWriteReport: boolean;
  canEditAnyTechReq: boolean;
  pocDeptIds: string[];
  currentUserOpenId: string;
  selfParticipantRole: "participant" | "follower" | null;
};

export default function EventDetailClient({
  productionId, event: initialEvent,
  initialScheduleItems, initialTechReqs, initialCallTimes,
  initialReports, departments, members, versions,
  canEdit, canScheduleEdit, canAssignPeople, canCallEdit,
  canTechReqDelete, canWriteReport, canEditAnyTechReq, pocDeptIds,
  currentUserOpenId,
  selfParticipantRole: initialSelfRole,
}: Props) {
  const [tab, setTab] = useState<Tab>("info");
  const [event, setEvent] = useState(initialEvent);
  const [selfRole, setSelfRole] = useState(initialSelfRole);
  const [followBusy, setFollowBusy] = useState(false);
  const [scheduleItems, setScheduleItems] = useState(initialScheduleItems);
  const [callTimes, setCallTimes] = useState(initialCallTimes);
  const [techReqs, setTechReqs] = useState(initialTechReqs);
  const [reports, setReports] = useState(initialReports);

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
    const people: { openId: string; name: string }[] = [];
    for (const item of scheduleItems) {
      for (const p of item.participants) {
        if (!seen.has(p.openId)) { seen.add(p.openId); people.push(p); }
      }
    }
    for (const tr of techReqs) {
      for (const a of tr.assignees) {
        if (!seen.has(a.openId)) { seen.add(a.openId); people.push({ openId: a.openId, name: a.name }); }
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

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <Link href={`/production/${productionId}/events`} className="text-xs text-zinc-400 hover:text-zinc-600">
            ← Events
          </Link>
          <span className="text-zinc-200 text-xs">|</span>
          <Link href={`/production/${productionId}/events/${event.id}/view`} className="text-xs text-zinc-400 hover:text-zinc-600">
            关注者视角
          </Link>
          <Link href={`/production/${productionId}/events/${event.id}/callsheet`} className="text-xs text-zinc-400 hover:text-zinc-600">
            Call Sheet
          </Link>
          <Link href={`/production/${productionId}/events/${event.id}/reqs`} className="text-xs text-zinc-400 hover:text-zinc-600">
            技术需求
          </Link>
        </div>

        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-lg font-bold text-zinc-800 leading-tight">{event.title}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-zinc-400">{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
              {event.startTime && <span className="text-xs text-zinc-400">{fmt(event.startTime)}</span>}
            </div>
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

        <div className="flex items-start mb-6 overflow-x-auto">
          {TABS.map((t, idx) => (
            <Fragment key={t.id}>
              <button onClick={() => setTab(t.id)}
                className="flex flex-col items-center gap-1.5 shrink-0 min-w-[52px]">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  tab === t.id
                    ? "bg-zinc-800 text-white"
                    : "bg-white text-zinc-400 shadow-sm"
                }`}>
                  {idx + 1}
                </div>
                <span className={`text-[9px] font-medium text-center leading-tight whitespace-nowrap transition-colors ${
                  tab === t.id ? "text-zinc-800" : "text-zinc-400"
                }`}>
                  {t.label}
                </span>
              </button>
              {idx < TABS.length - 1 && (
                <div className="flex-1 h-px bg-zinc-200 mt-3.5 min-w-2" />
              )}
            </Fragment>
          ))}
        </div>

        <div className="rounded-2xl bg-zinc-50 p-4">
          {tab === "info" && (
            <InfoTab
              event={event} productionId={productionId} members={members} canEdit={canEdit}
              departments={departments} versions={versions}
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
              stageManagerOpenIds={new Set(event.stageManagers.map(m => m.openId))}
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
            <div className="flex flex-col gap-3">
              {reports.length === 0 && (
                <p className="text-sm text-zinc-400 text-center py-6">暂无报告</p>
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
                  <div key={r.id} className="flex items-center gap-3 rounded-xl bg-white shadow-sm px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-zinc-800 truncate block">{r.title}</span>
                    </div>
                    <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 font-medium ${isPublished ? "bg-green-50 text-green-600" : "bg-zinc-100 text-zinc-500"}`}>
                      {isPublished ? "已发布" : "草稿"}
                    </span>
                    {canWriteReport && (
                      <button onClick={togglePublish}
                        className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          isPublished
                            ? "border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                            : "bg-green-600 text-white hover:bg-green-700"
                        }`}>
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
              members={members.map(m => ({ openId: m.openId, name: m.name }))}
              canWrite={canWriteReport}
              currentUserOpenId={currentUserOpenId}
              versionId={event.versionId ?? null}
              onReportsChange={setReports}
            />
          )}
        </div>
      </div>
    </div>
  );
}
