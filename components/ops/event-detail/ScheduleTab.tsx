"use client";

import { useState } from "react";
import CommentAssetPicker, { type PendingAsset } from "@/components/assets/CommentAssetPicker";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { EventScheduleItemWithParticipants, ScheduleItemParticipant, EventTechReq, EventDepartment } from "@/lib/ops/event-db";
import { datetimeLocalToIso } from "@/lib/tz";
import ParticipantPicker from "./ParticipantPicker";
import ScheduleItemRow from "./ScheduleItemRow";
import ScheduleTableView from "./ScheduleTableView";
import { SCHEDULE_ITEM_TYPE_LABELS } from "./labels";
import { toLocalInput } from "./time";

export default function ScheduleTab({
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
  const [newPendingAssets, setNewPendingAssets] = useState<PendingAsset[]>([]);
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
    if (newPendingAssets.length > 0) {
      await Promise.all(newPendingAssets.map(({ id: assetId }) =>
        fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/mounts`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mountType: "event_schedule", mountId: newId }),
        })
      ));
    }
    onItemsChange([...items, { ...data.item, participants, departmentIds: newDeptIds }]);
    setNewTitle(""); setNewType("custom"); setNewStart(""); setNewEnd(""); setNewLoc("");
    setNewParticipants([]);
    setNewDeptIds([]);
    setNewNotifyDepts([]);
    setNewPendingAssets([]);
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
              <OverflowSafeSelect value={newType} onChange={e => setNewType(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                {Object.entries(SCHEDULE_ITEM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </OverflowSafeSelect>
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
            <CommentAssetPicker
              productionId={productionId}
              selected={newPendingAssets}
              onSelect={setNewPendingAssets}
              label="流程附件"
            />

            <div className="flex gap-2">
              <button onClick={addItem}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700">
                添加
              </button>
              <button onClick={() => { setAdding(false); setNewParticipants([]); setNewDeptIds([]); setNewPendingAssets([]); }}
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
