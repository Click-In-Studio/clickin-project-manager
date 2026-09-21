"use client";

import { useState } from "react";
import SmartTextarea from "@/components/editor/SmartTextarea";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import type { EventScheduleItemWithParticipants, EventTechReq, EventDepartment } from "@/lib/ops/event-db";
import AssigneeEditorInline from "./AssigneeEditorInline";
import ScheduleItemPicker from "./ScheduleItemPicker";
import TechReqCard from "./TechReqCard";

export default function TechReqTab({
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
  const [newAssignees, setNewAssignees] = useState<{ userId: string; name: string }[]>([]);
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
    const set = new Set([...dept.memberUserIds, ...dept.pocUserIds]);
    return members.filter(m => set.has(m.userId));
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
              <SmartTextarea value={newDesc} onChange={setNewDesc} contentMention={{ productionId, versionId }} rows={2} placeholder="描述"
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
              <OverflowSafeSelect value={newDeptId} onChange={e => {
                  const next = e.target.value;
                  setNewDeptId(next);
                  if (next) {
                    const dept = departments.find(d => d.id === next);
                    const set = new Set(dept?.memberUserIds ?? []);
                    setNewAssignees(prev => prev.filter(a => set.has(a.userId)));
                  }
                }}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                <option value="">无部门</option>
                {departments
                  .filter(d => canEdit || pocDeptIds.includes(d.id))
                  .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </OverflowSafeSelect>
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
