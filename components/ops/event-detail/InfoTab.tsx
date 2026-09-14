"use client";

import { useState } from "react";
import MountPointAssets from "@/components/assets/MountPointAssets";
import SmartTextarea from "@/components/editor/SmartTextarea";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import SmartText from "@/components/ui/SmartText";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import type { ProductionEvent, EventTechReq, EventDepartment } from "@/lib/ops/event-db";
import { datetimeLocalToIso, dateTimeToIso, fmtDateTime as fmt, fmtDateLong } from "@/lib/tz";
import AssigneeEditorInline from "./AssigneeEditorInline";
import { EVENT_TYPE_LABELS } from "./labels";
import { toLocalInput, toLocalDate, isSingleDayEvent } from "./time";

const SM_EVENT_TYPES = new Set(["rehearsal", "meeting"]);

export default function InfoTab({
  event, productionId, members, canEdit, departments,
  onUpdated, onDeleted, onTechReqsCreated,
}: {
  event: ProductionEvent; productionId: string;
  members: MemberWithRoles[];
  canEdit: boolean;
  departments: EventDepartment[];
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
  const [stageManagers, setStageManagers] = useState<{ userId: string; name: string }[]>(event.stageManagers);
  const versionId = event.versionId ?? null;
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
            <OverflowSafeSelect value={eventType} onChange={e => setEventType(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
              <option value="rehearsal">排练</option>
              <option value="performance">演出</option>
              <option value="meeting">会议</option>
              <option value="custom">其他</option>
            </OverflowSafeSelect>
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
          <SmartTextarea value={description} onChange={setDescription} rows={3}
            contentMention={{ productionId, versionId }}
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
            <dd className="text-zinc-700"><SmartText content={event.description} productionId={productionId} versionId={versionId} /></dd>
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

      <div className="pt-2 border-t border-zinc-100">
        <MountPointAssets
          productionId={productionId}
          mountType="event"
          mountId={event.id}
          label={event.title}
          canEdit={canEdit}
          display="panel"
        />
      </div>
    </div>
  );
}
