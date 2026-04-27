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
  pending: "待处理", in_progress: "进行中", done: "完成",
};
const TECH_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-600",
  in_progress: "bg-blue-50 text-blue-600",
  done: "bg-green-50 text-green-600",
};

import { isoToDatetimeLocal, isoToDateInput, isoToTimeInput, datetimeLocalToIso, dateTimeToIso, fmtDateTime as fmt, fmtTime, fmtDateLong } from "@/lib/tz";

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
  event, productionId, members, canEdit,
  onUpdated, onDeleted,
}: {
  event: ProductionEvent; productionId: string;
  members: MemberWithRoles[];
  canEdit: boolean;
  onUpdated: (ev: ProductionEvent) => void;
  onDeleted: () => void;
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
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.event) { onUpdated(data.event); setEditing(false); }
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
        <div>
          <label className="block text-xs text-zinc-500 mb-1">备注</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
        </div>
        {showSM && (
          <div>
            <label className="block text-xs text-zinc-500 mb-1">跟组舞监</label>
            {smMembers.length === 0 ? (
              <p className="text-xs text-zinc-400">无舞台监督 / 助理舞台监督成员</p>
            ) : (
              <AssigneeEditorInline
                members={smMembers}
                assignees={stageManagers}
                onChange={setStageManagers}
              />
            )}
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
            <dd className="text-zinc-700 whitespace-pre-wrap">{event.description}</dd>
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
}: {
  members: MemberWithRoles[];
  selected: ScheduleItemParticipant[];
  onChange: (next: ScheduleItemParticipant[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selected.map(p => p.openId));

  const filtered = members.filter(m =>
    !search || m.name.includes(search) || m.roles.some(r => r.includes(search))
  );

  function toggle(m: MemberWithRoles) {
    if (selectedSet.has(m.openId)) {
      onChange(selected.filter(p => p.openId !== m.openId));
    } else {
      onChange([...selected, { openId: m.openId, name: m.name }]);
    }
  }

  const groups = groupByRole(filtered);

  return (
    <div className="flex flex-col gap-2">
      <input placeholder="搜索姓名或职位…" value={search} onChange={e => setSearch(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
      {filtered.length === 0 && <p className="text-xs text-zinc-400">无匹配成员</p>}
      <div className="max-h-64 overflow-y-auto flex flex-col gap-3">
        {groups.map(({ role, members: gm }) => (
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
}: {
  eventId: string; productionId: string;
  items: EventScheduleItemWithParticipants[];
  onItemsChange: (items: EventScheduleItemWithParticipants[]) => void;
  canEdit: boolean; canAssignPeople: boolean;
  members: MemberWithRoles[];
  eventStart: string | null; eventEnd: string | null;
  singleDay: boolean; eventDate: string;
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("custom");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newLoc, setNewLoc] = useState("");
  const [newParticipants, setNewParticipants] = useState<ScheduleItemParticipant[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

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
    onItemsChange([...items, { ...data.item, participants }]);
    setNewTitle(""); setNewType("custom"); setNewStart(""); setNewEnd(""); setNewLoc("");
    setNewParticipants([]);
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
                <ParticipantPicker members={members} selected={newParticipants} onChange={setNewParticipants} />
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={addItem}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700">
                添加
              </button>
              <button onClick={() => { setAdding(false); setNewParticipants([]); }}
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
    </div>
  );
}

function ScheduleItemRow({
  item, canEdit, canAssignPeople, members,
  editing, onEdit, onSaved, onDelete, base, minTime, maxTime,
  singleDay, eventDate,
}: {
  item: EventScheduleItemWithParticipants;
  canEdit: boolean; canAssignPeople: boolean; members: MemberWithRoles[];
  editing: boolean; onEdit: () => void;
  onSaved: (updated: EventScheduleItemWithParticipants) => void;
  onDelete: () => void;
  base: string;
  minTime?: string; maxTime?: string;
  singleDay: boolean; eventDate: string;
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
        }),
      }),
      fetch(`${base}/${item.id}/participants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: localParticipants }),
      }),
    ]);
    const data = await fieldRes.json();
    setSaving(false);
    if (data.item) { onSaved({ ...data.item, participants: localParticipants }); onEdit(); }
  }

  function cancel() {
    setTitle(item.title); setItemType(item.itemType);
    setStartTime(singleDay ? toLocalTimeInput(item.startTime) : toLocalInput(item.startTime));
    setEndTime(singleDay ? toLocalTimeInput(item.endTime) : toLocalInput(item.endTime));
    setLocation(item.location); setNotes(item.notes);
    setLocalParticipants(item.participants);
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
          <textarea placeholder="备注" value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
        </div>

        {canAssignPeople && members.length > 0 && (
          <div className="pt-2 border-t border-zinc-100">
            <p className="text-xs text-zinc-400 mb-2">参与人员</p>
            <ParticipantPicker members={members} selected={localParticipants} onChange={setLocalParticipants} />
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

  return (
    <div className="rounded-xl bg-white shadow-sm px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-800 truncate">{item.title}</span>
          <span className="shrink-0 text-[11px] rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">
            {SCHEDULE_ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
          </span>
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
  onCallTimesChange,
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
  person, callTime, suggestedCallAt, canEdit, singleDay, eventDate, onSave, onDelete,
}: {
  person: { openId: string; name: string };
  callTime: EventCallTime | null;
  suggestedCallAt: string | null;
  canEdit: boolean;
  singleDay: boolean; eventDate: string;
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
          <input placeholder="备注" value={notes} onChange={e => setNotes(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm focus:outline-none focus:border-zinc-400 w-24" />
          <button onClick={save} className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-xs font-medium">设置</button>
          <button onClick={() => setEditing(false)} className="text-xs text-zinc-400">取消</button>
          {callTime && (
            <button onClick={() => { onDelete(); setEditing(false); }} className="text-xs text-red-400">删除</button>
          )}
        </div>
        {editIsLate && suggestedLocal && (
          <p className="text-xs text-amber-600 pl-[92px]">
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
          {callTime.notes && <span className="text-xs text-zinc-400">{callTime.notes}</span>}
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
  scheduleItems, deptMembers, base,
  onUpdate, onDelete, canDelete,
}: {
  req: EventTechReq;
  expanded: boolean;
  onToggleExpand: () => void;
  canEditThisReq: boolean;
  isEventClosed: boolean;
  scheduleItems: EventScheduleItemWithParticipants[];
  deptMembers: MemberWithRoles[];
  base: string;
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
          description: editDesc.trim() || null,
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
              <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2}
                placeholder="描述（可选）"
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
              {req.description && <p className="text-sm text-zinc-600 pt-2">{req.description}</p>}
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
  pocDeptIds, eventStatus, onTechReqsChange,
}: {
  eventId: string; productionId: string;
  techReqs: EventTechReq[]; departments: EventDepartment[]; members: MemberWithRoles[];
  scheduleItems: EventScheduleItemWithParticipants[];
  canEdit: boolean; canDelete: boolean;
  pocDeptIds: string[];
  eventStatus: string;
  onTechReqsChange: (reqs: EventTechReq[]) => void;
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
    const set = new Set(dept.memberOpenIds);
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
        base={base}
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
              <textarea placeholder="描述" value={newDesc} onChange={e => setNewDesc(e.target.value)} rows={2}
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
  members, assignees, onChange,
}: {
  members: MemberWithRoles[];
  assignees: { openId: string; name: string }[];
  onChange: (next: { openId: string; name: string }[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = new Set(assignees.map(a => a.openId));
  const filtered = members.filter(m =>
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
  req, members, canEdit, onSave,
}: {
  req: EventTechReq; members: MemberWithRoles[];
  canEdit: boolean; onSave: (assignees: { openId: string; name: string }[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const assigneeSet = new Set(req.assignees.map(a => a.openId));

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

  const filtered = members.filter(m =>
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
  eventId, productionId, reports, departments, canWrite,
  currentUserOpenId, onReportsChange,
}: {
  eventId: string; productionId: string;
  reports: EventReport[]; departments: EventDepartment[];
  canWrite: boolean;
  currentUserOpenId: string;
  onReportsChange: (rs: EventReport[]) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("rehearsal");

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports`;

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
            onClick={() => setExpandedId(expandedId === report.id ? null : report.id)}>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-zinc-800 truncate block">{report.title}</span>
              <span className="text-xs text-zinc-400">
                {fmt(report.createdAt)} · {report.publishedAt ? "已发布" : "草稿"}
              </span>
            </div>
            <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 font-medium ${report.publishedAt ? "bg-green-50 text-green-600" : "bg-zinc-100 text-zinc-500"}`}>
              {report.publishedAt ? "已发布" : "草稿"}
            </span>
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
              canWrite={canWrite}
              currentUserOpenId={currentUserOpenId}
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
  report, departments, eventId, productionId, canWrite,
  currentUserOpenId,
  onUpdated, onDelete,
}: {
  report: EventReport; departments: EventDepartment[];
  eventId: string; productionId: string; canWrite: boolean;
  currentUserOpenId: string;
  onUpdated: (r: EventReport) => void; onDelete: () => void;
}) {
  const [body, setBody] = useState(report.body);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports`;
  const isPublished = !!report.publishedAt;

  async function saveBody() {
    setSaving(true);
    const res = await fetch(`${base}/${report.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
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
          <label className="text-xs text-zinc-400">正文（Markdown）</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={10}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-400 resize-none" />
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
            ? <p className="text-sm text-zinc-700 whitespace-pre-wrap leading-relaxed">{report.body}</p>
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
        currentUserOpenId={currentUserOpenId}
        isPublished={isPublished}
      />
    </div>
  );
}

function DeptNotesList({
  reportId, eventId, productionId, departments,
  currentUserOpenId, isPublished,
}: {
  reportId: string; eventId: string; productionId: string;
  departments: EventDepartment[];
  currentUserOpenId: string;
  isPublished: boolean;
}) {
  const [notes, setNotes] = useState<EventReportNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [newDeptId, setNewDeptId] = useState(departments[0]?.id ?? "");
  const [newContent, setNewContent] = useState("");

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
      body: JSON.stringify({ departmentId: newDeptId, content: newContent.trim() }),
    });
    const data = await res.json();
    if (data.note) { setNotes(prev => [...prev, data.note]); setNewContent(""); }
  }

  async function saveEdit(id: string) {
    if (!editDraft.trim()) return;
    const res = await fetch(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editDraft.trim() }),
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
                    <button onClick={() => { setEditingId(editingId === note.id ? null : note.id); setEditDraft(note.content); }}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600">
                      {editingId === note.id ? "取消" : "编辑"}
                    </button>
                  )}
                  <button onClick={() => deleteNote(note.id)} className="text-xs text-zinc-300 hover:text-red-400">×</button>
                </div>
              )}
            </div>
            {editingId === note.id ? (
              <div className="flex gap-2">
                <input value={editDraft} onChange={e => setEditDraft(e.target.value)}
                  className="flex-1 rounded-lg border border-zinc-200 px-2 py-1 text-sm focus:outline-none" />
                <button onClick={() => saveEdit(note.id)}
                  className="px-2 py-1 text-xs rounded-lg bg-zinc-800 text-white">保存</button>
              </div>
            ) : (
              <p className="text-sm text-zinc-700">{note.content}</p>
            )}
          </div>
        );
      })}
      {!isPublished && departments.length > 0 && (
        <div className="flex gap-2 mt-1">
          <select value={newDeptId} onChange={e => setNewDeptId(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs focus:outline-none shrink-0">
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input value={newContent} onChange={e => setNewContent(e.target.value)}
            placeholder="添加 note…" onKeyDown={e => e.key === "Enter" && addNote()}
            className="flex-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-400" />
          <button onClick={addNote}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-xs font-medium">添加</button>
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
  event, productionId, scheduleItems, callTimes, eventPeople, canEdit, onUpdated,
  onAllTechReqsCompleted,
}: {
  event: ProductionEvent; productionId: string;
  scheduleItems: EventScheduleItemWithParticipants[];
  callTimes: EventCallTime[];
  eventPeople: { openId: string; name: string }[];
  canEdit: boolean;
  onUpdated: (ev: ProductionEvent) => void;
  onAllTechReqsCompleted?: () => void;
}) {
  async function changeStatus(status: string) {
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
  initialReports, departments, members,
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
              onUpdated={setEvent} onDeleted={handleDeleted}
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
            />
          )}
          {tab === "publish" && (
            <PublishTab
              event={event} productionId={productionId}
              scheduleItems={scheduleItems} callTimes={callTimes}
              eventPeople={eventPeople}
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
              reports={reports} departments={departments} canWrite={canWriteReport}
              currentUserOpenId={currentUserOpenId}
              onReportsChange={setReports}
            />
          )}
        </div>
      </div>
    </div>
  );
}
