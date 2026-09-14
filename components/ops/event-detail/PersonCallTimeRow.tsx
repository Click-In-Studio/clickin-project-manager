"use client";

import { useState } from "react";
import SmartTextarea from "@/components/editor/SmartTextarea";
import SmartText from "@/components/ui/SmartText";
import type { EventCallTime } from "@/lib/ops/event-db";
import { fmtTime } from "@/lib/tz";
import { toLocalInput, toLocalTimeInput } from "./time";

export default function PersonCallTimeRow({
  person, callTime, suggestedCallAt, canEdit, singleDay, eventDate, productionId, versionId, onSave, onDelete,
}: {
  person: { userId: string; name: string };
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
          contentMention={{ productionId, versionId }}
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
          {callTime.notes && <span className="text-xs text-zinc-400"><SmartText content={callTime.notes} productionId={productionId} /></span>}
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
