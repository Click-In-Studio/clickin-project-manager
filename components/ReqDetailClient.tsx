"use client";

import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { EventTechReq, EventScheduleItem, ProductionEvent } from "@/lib/event-db";
import { fmtTime, fmtDateTime } from "@/lib/tz";

const SCHEDULE_ITEM_TYPE_LABELS: Record<string, string> = {
  scene_rehearsal: "场景排练",
  fitting: "服装",
  sound_check: "音响",
  tech_rehearsal: "技排",
  meeting: "会议",
  break: "休息",
  custom: "其他",
};

const STATUS_OPTIONS = [
  { value: "pending",     label: "待处理" },
  { value: "in_progress", label: "进行中" },
  { value: "done",        label: "完成"   },
];
const STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};
const STATUS_COLORS: Record<string, string> = {
  awaiting:    "bg-purple-50 text-purple-500",
  pending:     "bg-amber-50 text-amber-600",
  in_progress: "bg-blue-50 text-blue-600",
  done:        "bg-green-50 text-green-600",
};

function fmtItemTime(item: EventScheduleItem, singleDay: boolean): string {
  if (!item.startTime) return "";
  return singleDay ? fmtTime(item.startTime) : fmtDateTime(item.startTime);
}

function isSingleDay(event: ProductionEvent): boolean {
  if (!event.startTime || !event.endTime) return false;
  return event.startTime.slice(0, 10) === event.endTime.slice(0, 10);
}

type Props = {
  req: EventTechReq;
  event: ProductionEvent;
  scheduleItems: EventScheduleItem[];
  deptName: string | null;
  deptPeople: { openId: string; name: string }[];
  isPocOfDept: boolean;
  isAssignee: boolean;
  canViewFull: boolean;
  productionId: string;
};

export default function ReqDetailClient({
  req: initialReq, event, scheduleItems,
  deptName, deptPeople,
  isPocOfDept, isAssignee, canViewFull,
  productionId,
}: Props) {
  const [req, setReq] = useState(initialReq);
  const [title, setTitle] = useState(initialReq.title);
  const [description, setDescription] = useState(initialReq.description);
  const [assignees, setAssignees] = useState(initialReq.assignees);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const singleDay = isSingleDay(event);
  const linkedIds = new Set(req.scheduleItemIds);
  const canEdit = req.status === "awaiting" && isPocOfDept;
  const canChangeStatus = isPocOfDept || isAssignee || canViewFull;

  const sortedItems = [...scheduleItems].sort((a, b) => {
    if (!a.startTime && !b.startTime) return a.orderIndex - b.orderIndex;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  function toggleAssignee(person: { openId: string; name: string }) {
    setAssignees(prev =>
      prev.some(a => a.openId === person.openId)
        ? prev.filter(a => a.openId !== person.openId)
        : [...prev, person]
    );
  }

  const base = `${BASE_PATH}/api/production/${productionId}/events/${event.id}/tech-reqs/${req.id}`;

  async function confirm(newStatus: string) {
    if (!title.trim()) { setError("请填写需求名称"); return; }
    setSaving(true);
    setError(null);
    try {
      await Promise.all([
        fetch(base, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), description }),
        }),
        fetch(`${base}/assignees`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignees }),
        }),
      ]);
      const res = await fetch(`${base}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) { setError("状态更新失败"); return; }
      setReq(r => ({ ...r, title: title.trim(), description, assignees, status: newStatus }));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(newStatus: string) {
    if (newStatus === req.status) return;
    setSaving(true);
    try {
      const res = await fetch(`${base}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) setReq(r => ({ ...r, status: newStatus }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">

        {/* Nav */}
        <div className="flex items-center gap-3 mb-6 text-xs text-zinc-400">
          <Link href={`/production/${productionId}/events/${event.id}/reqs`} className="hover:text-zinc-600">
            ← 需求列表
          </Link>
          <span className="text-zinc-300">/</span>
          <span className="truncate">{event.title}</span>
        </div>

        {/* Req header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            {deptName && (
              <span className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${STATUS_COLORS[req.status] ?? "bg-zinc-100 text-zinc-500"}`}>
                {deptName}
              </span>
            )}
            <span className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${STATUS_COLORS[req.status] ?? "bg-zinc-100 text-zinc-500"}`}>
              {STATUS_LABELS[req.status] ?? req.status}
            </span>
          </div>
          <h1 className={`text-lg font-bold ${req.title ? "text-zinc-800" : "text-zinc-400 italic"}`}>
            {req.title || "待填写需求名称…"}
          </h1>
        </div>

        {/* Schedule section */}
        {scheduleItems.length > 0 && (
          <section className="mb-6">
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-3">日程</p>
            <div className="flex flex-col gap-2">
              {sortedItems.map(item => {
                const linked = linkedIds.has(item.id);
                return (
                  <div key={item.id}
                    className={`rounded-xl px-4 py-3 text-sm flex items-start gap-3 ${
                      linked
                        ? "bg-purple-50 border border-purple-100"
                        : "bg-white shadow-sm opacity-60"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-medium ${linked ? "text-zinc-800" : "text-zinc-600"}`}>
                          {item.title}
                        </span>
                        <span className="text-[10px] text-zinc-400 bg-zinc-100 rounded px-1.5 py-0.5">
                          {SCHEDULE_ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
                        </span>
                        {linked && (
                          <span className="text-[10px] font-medium text-purple-500">● 此需求</span>
                        )}
                      </div>
                      {item.startTime && (
                        <p className="text-xs text-zinc-400 mt-0.5">
                          {fmtItemTime(item, singleDay)}
                          {item.location && ` · ${item.location}`}
                        </p>
                      )}
                      {item.notes && (
                        <p className="text-xs text-zinc-400 mt-0.5 truncate">{item.notes}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Req info section */}
        <section>
          <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-3">需求信息</p>

          {canEdit ? (
            /* Awaiting + POC: editable */
            <div className="bg-white rounded-2xl shadow-sm p-5 flex flex-col gap-4">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">需求名称 *</label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
                  placeholder="需求名称"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">详情</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400 resize-none"
                  placeholder="需求详情（可选）"
                />
              </div>
              {deptPeople.length > 0 && (
                <div>
                  <label className="block text-xs text-zinc-500 mb-2">负责人</label>
                  <div className="flex flex-wrap gap-1.5">
                    {deptPeople.map(p => {
                      const selected = assignees.some(a => a.openId === p.openId);
                      return (
                        <button key={p.openId} type="button"
                          onClick={() => toggleAssignee(p)}
                          className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                            selected
                              ? "bg-zinc-800 text-white border-zinc-800"
                              : "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400"
                          }`}
                        >{p.name}</button>
                      );
                    })}
                  </div>
                </div>
              )}
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="flex flex-wrap gap-2 pt-1 border-t border-zinc-50">
                <span className="text-xs text-zinc-400 self-center mr-1">确认并标为：</span>
                {STATUS_OPTIONS.map(opt => (
                  <button key={opt.value}
                    onClick={() => confirm(opt.value)}
                    disabled={saving}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${STATUS_COLORS[opt.value]} border border-current border-opacity-20`}
                  >
                    {saving ? "…" : opt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Non-awaiting: read-only + status buttons */
            <div className="bg-white rounded-2xl shadow-sm p-5 flex flex-col gap-4">
              <div>
                <p className="text-xs text-zinc-400 mb-1">需求名称</p>
                <p className="text-sm font-medium text-zinc-800">{req.title || "（无标题）"}</p>
              </div>
              {req.description && (
                <div>
                  <p className="text-xs text-zinc-400 mb-1">详情</p>
                  <p className="text-sm text-zinc-600 whitespace-pre-wrap">{req.description}</p>
                </div>
              )}
              {req.assignees.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-400 mb-2">负责人</p>
                  <div className="flex flex-wrap gap-1.5">
                    {req.assignees.map(a => (
                      <span key={a.openId}
                        className="rounded-full px-3 py-1 text-xs bg-zinc-50 text-zinc-600 border border-zinc-100">
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {canChangeStatus && (
                <div className="flex flex-wrap gap-2 pt-1 border-t border-zinc-50">
                  {STATUS_OPTIONS.map(opt => (
                    <button key={opt.value}
                      onClick={() => changeStatus(opt.value)}
                      disabled={saving}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                        req.status === opt.value
                          ? (STATUS_COLORS[opt.value] ?? "") + " ring-1 ring-current ring-opacity-30"
                          : "bg-zinc-50 text-zinc-400 hover:bg-zinc-100 disabled:opacity-60"
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
