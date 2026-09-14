"use client";

import { useState } from "react";
import SmartTextarea from "@/components/editor/SmartTextarea";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import type { EventScheduleItemWithParticipants, ScheduleItemParticipant, EventTechReq, EventDepartment } from "@/lib/ops/event-db";
import { isoToDatetimeLocal, isoToTimeInput, datetimeLocalToIso } from "@/lib/tz";
import ParticipantPicker from "./ParticipantPicker";
import { SCHEDULE_ITEM_TYPE_LABELS } from "./labels";
import { toLocalInput } from "./time";

export type ModalState =
  | { mode: "edit"; item: EventScheduleItemWithParticipants }
  | { mode: "new"; startTime: string | null; deptId: string | null };

export default function ScheduleItemModal({
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
          <OverflowSafeSelect value={itemType} onChange={e => setItemType(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
            {Object.entries(SCHEDULE_ITEM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </OverflowSafeSelect>
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
            contentMention={{ productionId, versionId }}
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
