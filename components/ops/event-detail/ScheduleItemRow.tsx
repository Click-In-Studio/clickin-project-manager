"use client";

import { useState } from "react";
import MountPointAssets from "@/components/assets/MountPointAssets";
import SmartTextarea from "@/components/editor/SmartTextarea";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { EventScheduleItemWithParticipants, ScheduleItemParticipant, EventTechReq, EventDepartment } from "@/lib/ops/event-db";
import { datetimeLocalToIso, fmtTime } from "@/lib/tz";
import ParticipantPicker from "./ParticipantPicker";
import { SCHEDULE_ITEM_TYPE_LABELS } from "./labels";
import { toLocalInput, toLocalTimeInput } from "./time";

export default function ScheduleItemRow({
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
          <OverflowSafeSelect value={itemType} onChange={e => setItemType(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
            {Object.entries(SCHEDULE_ITEM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </OverflowSafeSelect>
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
            contentMention={{ productionId, versionId }}
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

        <div className="pt-2 border-t border-zinc-100">
          <MountPointAssets
            productionId={productionId}
            mountType="event_schedule"
            mountId={item.id}
            label={item.title}
            canEdit={true}
            display="panel"
          />
        </div>

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
    <div className="rounded-xl bg-white shadow-sm px-4 py-3">
      <div className="flex items-center gap-3">
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
      <MountPointAssets
        productionId={productionId}
        mountType="event_schedule"
        mountId={item.id}
        label={item.title}
        display="compact"
      />
    </div>
  );
}
