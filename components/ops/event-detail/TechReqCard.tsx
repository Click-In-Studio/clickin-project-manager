"use client";

import { useState } from "react";
import MountPointAssets from "@/components/assets/MountPointAssets";
import SmartTextarea from "@/components/editor/SmartTextarea";
import ChevronIcon from "@/components/ui/ChevronIcon";
import SmartText from "@/components/ui/SmartText";
import type { MemberWithRoles } from "@/lib/db";
import type { EventScheduleItemWithParticipants, EventTechReq } from "@/lib/ops/event-db";
import AssigneeEditor from "./AssigneeEditor";
import ScheduleItemPicker from "./ScheduleItemPicker";
import { TECH_STATUS_LABELS, TECH_STATUS_COLORS } from "./labels";

export default function TechReqCard({
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

  async function handleAssigneesChange(assignees: { userId: string; name: string }[]) {
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
        <ChevronIcon direction={expanded ? "up" : "down"} size={14} className="shrink-0 text-zinc-300" />
      </div>
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-zinc-100">
          {editable ? (
            <>
              <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 mt-2" />
              <SmartTextarea value={editDesc} onChange={setEditDesc} rows={2}
                placeholder="描述（可选）"
                contentMention={{ productionId, versionId }}
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
              {req.description && <p className="text-sm text-zinc-600 pt-2"><SmartText content={req.description} productionId={productionId} /></p>}
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
          <MountPointAssets
            productionId={productionId}
            mountType="task"
            mountId={req.id}
            label={req.title}
            canEdit={canEditThisReq && !isEventClosed}
            display="panel"
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
