"use client";

import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionEvent, EventDepartment } from "@/lib/event-db";
import { fmtDateTimeSmart, datetimeLocalToIso, dateTimeToIso } from "@/lib/tz";

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练",
  performance: "演出",
  meeting: "会议",
  custom: "其他",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  completed: "已完成",
  cancelled: "已取消",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-500",
  published: "bg-blue-50 text-blue-600",
  completed: "bg-green-50 text-green-600",
  cancelled: "bg-red-50 text-red-400",
};

function formatDateTime(iso: string | null): string {
  return fmtDateTimeSmart(iso);
}

function EventCard({
  event, productionId, role, canViewFull, onFollow, onUnfollow,
}: {
  event: ProductionEvent;
  productionId: string;
  role: "participant" | "follower" | null;
  canViewFull: boolean;
  onFollow: (eventId: string) => void;
  onUnfollow: (eventId: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const method = role === "follower" ? "DELETE" : "POST";
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/follow`, { method });
      if (res.ok) {
        if (method === "POST") onFollow(event.id);
        else onUnfollow(event.id);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative rounded-2xl bg-white shadow-sm hover:shadow-md transition-shadow">
      <Link
        href={canViewFull
          ? `/production/${productionId}/events/${event.id}`
          : `/production/${productionId}/events/${event.id}/view`}
        className="block p-4 pr-20"
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-zinc-800 leading-snug">{event.title}</h3>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[event.status] ?? "bg-zinc-100 text-zinc-500"}`}>
            {STATUS_LABELS[event.status] ?? event.status}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">
            {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
          </span>
          {event.startTime && <span>{formatDateTime(event.startTime)}</span>}
          {event.location && <span>{event.location}</span>}
        </div>
      </Link>
      <div className="absolute right-3 bottom-3">
        {role === "participant" ? (
          <span className="text-[11px] text-zinc-300 px-2 py-1">已参与</span>
        ) : (
          <button
            onClick={toggle}
            disabled={busy}
            className={`text-[11px] px-2 py-1 rounded-lg transition-colors disabled:opacity-50 ${
              role === "follower"
                ? "text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100"
                : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            {role === "follower" ? "已关注" : "关注"}
          </button>
        )}
      </div>
    </div>
  );
}

function CreateEventModal({
  productionId, departments,
  onClose,
  onCreated,
}: {
  productionId: string;
  departments: EventDepartment[];
  onClose: () => void;
  onCreated: (ev: ProductionEvent) => void;
}) {
  const [title, setTitle] = useState("");
  const [eventType, setEventType] = useState("rehearsal");
  const [location, setLocation] = useState("");
  const [singleDay, setSingleDay] = useState(false);
  const [singleDate, setSingleDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [description, setDescription] = useState("");
  const [notifyDeptIds, setNotifyDeptIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("请输入标题"); return; }
    const resolvedStart = singleDay ? (singleDate ? dateTimeToIso(singleDate, "00:00") : null) : (startTime ? datetimeLocalToIso(startTime) : null);
    const resolvedEnd   = singleDay ? (singleDate ? dateTimeToIso(singleDate, "23:59") : null) : (endTime   ? datetimeLocalToIso(endTime)   : null);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          eventType,
          location: location.trim(),
          startTime: resolvedStart,
          endTime: resolvedEnd,
          description: description.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "创建失败"); return; }
      if (notifyDeptIds.length > 0 && data.event?.id) {
        await fetch(`${BASE_PATH}/api/production/${productionId}/events/${data.event.id}/awaiting-reqs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentIds: notifyDeptIds }),
        });
      }
      onCreated(data.event);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-bold text-zinc-700 tracking-wide">新建事件</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-lg leading-none">×</button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">标题 *</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
              placeholder="事件标题"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">类型</label>
              <select
                value={eventType}
                onChange={e => setEventType(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
              >
                <option value="rehearsal">排练</option>
                <option value="performance">演出</option>
                <option value="meeting">会议</option>
                <option value="custom">其他</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">地点</label>
              <input
                value={location}
                onChange={e => setLocation(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
                placeholder="排练厅..."
              />
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
              <input
                type="date"
                value={singleDate}
                onChange={e => setSingleDate(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">开始时间</label>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={e => setStartTime(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">结束时间</label>
                <input
                  type="datetime-local"
                  value={endTime}
                  onChange={e => setEndTime(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400"
                />
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs text-zinc-500 mb-1">备注</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:border-zinc-400 resize-none"
              placeholder="可选..."
            />
          </div>
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
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700">
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type Props = {
  productionId: string;
  productionName: string;
  initialEvents: ProductionEvent[];
  canCreate: boolean;
  canViewFull: boolean;
  myParticipations: { eventId: string; role: "participant" | "follower" }[];
  currentUserId: string;
  departments: EventDepartment[];
};

export default function EventsClient({
  productionId, productionName, initialEvents, canCreate, canViewFull,
  myParticipations, departments,
}: Props) {
  const [events, setEvents] = useState(initialEvents);
  const [showCreate, setShowCreate] = useState(false);
  const [roles, setRoles] = useState<Map<string, "participant" | "follower">>(() =>
    new Map(myParticipations.map(p => [p.eventId, p.role]))
  );

  const now = new Date();
  const upcoming = events.filter(e => !e.startTime || new Date(e.startTime) >= now);
  const past = events.filter(e => e.startTime && new Date(e.startTime) < now);

  function handleCreated(ev: ProductionEvent) {
    setEvents(prev => [ev, ...prev].sort((a, b) => {
      if (!a.startTime && !b.startTime) return 0;
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    }));
    setShowCreate(false);
  }

  function handleFollow(eventId: string) {
    setRoles(prev => new Map(prev).set(eventId, "follower"));
  }

  function handleUnfollow(eventId: string) {
    setRoles(prev => { const m = new Map(prev); m.delete(eventId); return m; });
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href={`/production/${productionId}`} className="text-xs text-zinc-400 hover:text-zinc-600">
              ← {productionName}
            </Link>
            <h1 className="text-sm font-bold tracking-[0.15em] text-zinc-400 uppercase">Events</h1>
            <span className="shrink-0 rounded bg-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500">
              {canCreate ? "可创建" : "只读"}
            </span>
          </div>
          {canCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-zinc-800 text-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-700"
            >
              + 新建
            </button>
          )}
        </div>

        {events.length === 0 && (
          <p className="text-center text-sm text-zinc-400 py-12">暂无事件</p>
        )}

        {upcoming.length > 0 && (
          <section className="mb-6">
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-3">即将进行</p>
            <div className="flex flex-col gap-3">
              {upcoming.map(ev => (
                <EventCard
                  key={ev.id} event={ev} productionId={productionId}
                  role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                  onFollow={handleFollow} onUnfollow={handleUnfollow}
                />
              ))}
            </div>
          </section>
        )}

        {past.length > 0 && (
          <section>
            <p className="text-[11px] font-semibold tracking-widest text-zinc-300 uppercase mb-3">已过去</p>
            <div className="flex flex-col gap-3">
              {past.map(ev => (
                <EventCard
                  key={ev.id} event={ev} productionId={productionId}
                  role={roles.get(ev.id) ?? null} canViewFull={canViewFull}
                  onFollow={handleFollow} onUnfollow={handleUnfollow}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {showCreate && (
        <CreateEventModal
          productionId={productionId}
          departments={departments}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
