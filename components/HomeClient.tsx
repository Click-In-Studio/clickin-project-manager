"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { fmtCallAt, isoCSTDateStr, todayCSTStr as tzTodayCSTStr, fmtDate } from "@/lib/tz";
import type { MyCallTimeEntry, MyPendingTechReqEntry, MyFollowedEventEntry, UnreadReportEntry } from "@/lib/event-db";

function cstDateStr(iso: string): string { return isoCSTDateStr(iso); }
function todayCSTStr(): string { return tzTodayCSTStr(); }

type Production = { id: string; name: string; createdAt: string; archivedAt: string | null; sortOrder: number };

type Props = {
  productions: Production[];
  isAdmin: boolean;
  myCallTimes: MyCallTimeEntry[];
  myPendingReqs: MyPendingTechReqEntry[];
  myFollowedEvents: MyFollowedEventEntry[];
  myUnreadReports: UnreadReportEntry[];
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练", performance: "演出", meeting: "会议", custom: "其他",
};

function SectionCard({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white px-5 py-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] font-bold tracking-[0.14em] text-[#667676] uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function HomeClient({ productions: initial, isAdmin, myCallTimes, myPendingReqs, myFollowedEvents, myUnreadReports }: Props) {
  const router = useRouter();
  const [productions, setProductions] = useState<Production[]>(initial);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState(false);
  const [sortedActive, setSortedActive] = useState<Production[]>([]);
  const [sortSaving, setSortSaving] = useState(false);

  const create = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError("");
    const idempotencyKey = crypto.randomUUID();
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "创建失败"); return; }
      router.push(`/production/${data.id}`);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setCreating(false);
    }
  };

  const activeProductions = productions.filter(p => !p.archivedAt);
  const archivedProductions = productions.filter(p => p.archivedAt);

  const enterSortMode = () => {
    setSortedActive([...activeProductions]);
    setSortMode(true);
  };

  const moveItem = (idx: number, dir: -1 | 1) => {
    setSortedActive(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const saveSort = async () => {
    setSortSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: sortedActive.map(p => p.id) }),
      });
      if (!res.ok) return;
      setProductions([...sortedActive, ...archivedProductions]);
      setSortMode(false);
    } finally {
      setSortSaving(false);
    }
  };

  const deleteProduction = async (id: string) => {
    if (!confirm("确定要删除这个剧本吗？此操作不可撤销。")) return;
    setDeleting(id);
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setProductions(prev => prev.filter(p => p.id !== id));
    } catch { /* ignore */ } finally {
      setDeleting(null);
    }
  };

  const hasPersonalData = myCallTimes.length > 0 || myFollowedEvents.length > 0 || myUnreadReports.length > 0 || myPendingReqs.length > 0;

  return (
    <div className="px-5 py-8 lg:px-10">
      {/* Page header */}
      <div className="mb-6">
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#667676] mb-1">平台级</p>
        <h1 className="font-serif text-3xl font-medium text-[#182a2a] tracking-tight" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
          我的工作
        </h1>
      </div>

      {/* Two-column on desktop */}
      <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 max-w-4xl">

        {/* Left column: productions */}
        <div className="space-y-4">
          {/* Quick nav */}
          <div className="grid grid-cols-3 gap-2.5">
            <Link href="/my/weekly-call"
              className="rounded-xl bg-white px-3 py-4 shadow-sm text-center hover:shadow-md transition-shadow">
              <p className="text-[9px] font-bold tracking-widest text-[#667676] uppercase mb-1">Weekly</p>
              <p className="text-sm font-medium text-[#182a2a]">本周安排</p>
            </Link>
            <Link href={`/my/daily-call?date=${todayCSTStr()}`}
              className="rounded-xl bg-white px-3 py-4 shadow-sm text-center hover:shadow-md transition-shadow">
              <p className="text-[9px] font-bold tracking-widest text-[#667676] uppercase mb-1">Today</p>
              <p className="text-sm font-medium text-[#182a2a]">今日 Call</p>
            </Link>
            <Link href="/my/reqs"
              className="rounded-xl bg-white px-3 py-4 shadow-sm text-center hover:shadow-md transition-shadow">
              <p className="text-[9px] font-bold tracking-widest text-[#667676] uppercase mb-1">Reqs</p>
              <p className="text-sm font-medium text-[#182a2a]">我的需求</p>
            </Link>
          </div>

          {/* Productions */}
          <SectionCard
            title="项目"
            action={
              isAdmin && !sortMode ? (
                <button onClick={enterSortMode} className="text-[11px] text-[#667676] hover:text-[#182a2a] transition-colors">
                  排序
                </button>
              ) : sortMode ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => setSortMode(false)} disabled={sortSaving} className="text-[11px] text-[#667676] hover:text-[#182a2a]">取消</button>
                  <button onClick={saveSort} disabled={sortSaving} className="text-[11px] font-medium text-[#182a2a]">{sortSaving ? "保存中…" : "完成"}</button>
                </div>
              ) : null
            }
          >
            {productions.length === 0 && !showInput ? (
              <p className="text-center text-xs text-[#a0aeab] py-3">暂无项目</p>
            ) : sortMode ? (
              <ul className="space-y-1 mb-3">
                {sortedActive.map((p, idx) => (
                  <li key={p.id} className="flex items-center gap-1 rounded-lg bg-[#f4f2ec] px-2 py-2">
                    <div className="flex flex-col">
                      <button onClick={() => moveItem(idx, -1)} disabled={idx === 0}
                        className="text-[#a0aeab] hover:text-[#182a2a] disabled:opacity-20 leading-none text-xs px-1">▲</button>
                      <button onClick={() => moveItem(idx, 1)} disabled={idx === sortedActive.length - 1}
                        className="text-[#a0aeab] hover:text-[#182a2a] disabled:opacity-20 leading-none text-xs px-1">▼</button>
                    </div>
                    <span className="flex-1 px-2 text-sm text-[#182a2a]">{p.name}</span>
                  </li>
                ))}
                {archivedProductions.map(p => (
                  <li key={p.id} className="flex items-center gap-2 rounded-lg px-3 py-2.5 opacity-40">
                    <span className="flex-1 text-sm text-[#667676]">{p.name}</span>
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-widest uppercase bg-[#eeeee8] text-[#667676]">已归档</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-0.5 mb-3">
                {productions.map(p => (
                  <li key={p.id} className="group flex items-center gap-1 rounded-lg hover:bg-[#f4f2ec]">
                    <button
                      onClick={() => router.push(`/production/${p.id}`)}
                      className="flex-1 px-3 py-2.5 text-left text-sm flex items-center gap-2"
                    >
                      <span className={p.archivedAt ? "text-[#a0aeab]" : "text-[#182a2a]"}>{p.name}</span>
                      {p.archivedAt && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-widest uppercase bg-[#eeeee8] text-[#a0aeab]">
                          已归档
                        </span>
                      )}
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => deleteProduction(p.id)}
                        disabled={deleting === p.id}
                        title="删除项目"
                        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-[#a0aeab] opacity-0 group-hover:opacity-100 hover:text-red-400 disabled:opacity-30 transition-opacity"
                      >
                        删除
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isAdmin && (
              showInput ? (
                <>
                  <input
                    value={newName}
                    onChange={e => { setNewName(e.target.value); setError(""); }}
                    onKeyDown={e => e.key === "Enter" && create()}
                    placeholder="输入项目名"
                    autoFocus
                    className="w-full rounded-lg border border-[#dfe5e2] px-4 py-2.5 text-sm text-[#182a2a] outline-none placeholder:text-[#a0aeab] focus:border-[#182a2a]"
                  />
                  {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={() => { setShowInput(false); setNewName(""); setError(""); }}
                      className="flex-1 rounded-lg border border-[#dfe5e2] py-2.5 text-sm text-[#667676] hover:border-[#182a2a] transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={create}
                      disabled={!newName.trim() || creating}
                      className="flex-1 rounded-lg bg-[#182a2a] py-2.5 text-sm font-medium text-white hover:bg-[#2b4140] disabled:opacity-30 transition-colors"
                    >
                      {creating ? "创建中…" : "创建"}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => setShowInput(true)}
                  className="w-full rounded-lg border border-[#dfe5e2] py-2.5 text-sm font-medium text-[#667676] hover:border-[#182a2a] hover:text-[#182a2a] transition-colors"
                >
                  新建项目
                </button>
              )
            )}
          </SectionCard>
        </div>

        {/* Right column: personal data */}
        {hasPersonalData && (
          <div className="space-y-4">
            {/* Call times */}
            {myCallTimes.length > 0 && (
              <SectionCard
                title={<>本周我的 Call <span className="font-normal normal-case text-[#a0aeab]">UTC+8</span></>}
                action={
                  <Link href="/my/weekly-call" className="text-[11px] text-[#667676] hover:text-[#182a2a]">
                    完整安排 →
                  </Link>
                }
              >
                {(() => {
                  const byDate = new Map<string, MyCallTimeEntry[]>();
                  for (const ct of myCallTimes) {
                    const d = cstDateStr(ct.callAt);
                    if (!byDate.has(d)) byDate.set(d, []);
                    byDate.get(d)!.push(ct);
                  }
                  return [...byDate.entries()].map(([date, calls]) => (
                    <div key={date} className="mb-3 last:mb-0">
                      <div className="flex items-center justify-between mb-1 px-1">
                        <span className="text-[11px] font-medium text-[#a0aeab]">{fmtCallAt(calls[0].callAt).split(" ")[0]}</span>
                        <Link href={`/my/daily-call?date=${date}`} className="text-[11px] text-[#667676] hover:text-[#182a2a]">
                          当日 Call →
                        </Link>
                      </div>
                      <ul className="space-y-0.5">
                        {calls.map(ct => (
                          <li key={ct.id}>
                            <button
                              onClick={() => router.push(`/production/${ct.productionId}/events/${ct.eventId}/callsheet`)}
                              className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-[#f4f2ec] transition-colors"
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-sm font-medium text-[#182a2a]">{ct.eventTitle}</span>
                                <span className="shrink-0 text-xs font-mono text-[#a55c32] font-medium">{fmtCallAt(ct.callAt)}</span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#a0aeab]">
                                <span>{ct.productionName}</span>
                                {ct.eventLocation && <><span>·</span><span>{ct.eventLocation}</span></>}
                                {ct.notes && <><span>·</span><span className="truncate max-w-[100px]">{ct.notes}</span></>}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ));
                })()}
              </SectionCard>
            )}

            {/* Followed events */}
            {myFollowedEvents.length > 0 && (
              <SectionCard title="我关注的事件">
                <ul className="space-y-0.5">
                  {myFollowedEvents.map(ev => (
                    <li key={ev.eventId}>
                      <button
                        onClick={() => router.push(`/production/${ev.productionId}/events/${ev.eventId}`)}
                        className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-[#f4f2ec] transition-colors"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-[#182a2a]">{ev.eventTitle}</span>
                          {ev.startTime && (
                            <span className="shrink-0 text-xs font-mono text-[#667676]">{fmtCallAt(ev.startTime)}</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#a0aeab]">
                          <span className="rounded bg-[#eeeee8] px-1 py-0.5 text-[#667676]">
                            {EVENT_TYPE_LABELS[ev.eventType] ?? ev.eventType}
                          </span>
                          <span>{ev.productionName}</span>
                          {ev.eventLocation && <><span>·</span><span>{ev.eventLocation}</span></>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            {/* Unread reports */}
            {myUnreadReports.length > 0 && (
              <SectionCard title="未读报告">
                <ul className="space-y-0.5">
                  {myUnreadReports.map(r => (
                    <li key={r.reportId}>
                      <button
                        onClick={() => router.push(`/production/${r.productionId}/events/${r.eventId}/reports/${r.reportId}`)}
                        className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-[#f4f2ec] transition-colors"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-[#182a2a]">{r.reportTitle}</span>
                          <span className="shrink-0 text-xs font-mono text-[#a0aeab]">{fmtDate(r.publishedAt)}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#a0aeab]">
                          {r.eventTitle} · {r.productionName}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            {/* Pending reqs */}
            {myPendingReqs.length > 0 && (
              <SectionCard
                title="我负责的待处理需求"
                action={
                  <Link href="/my/reqs" className="text-[11px] text-[#667676] hover:text-[#182a2a]">查看全部 →</Link>
                }
              >
                <ul className="space-y-0.5">
                  {myPendingReqs.map(req => (
                    <li key={req.id}>
                      <button
                        onClick={() => router.push(`/production/${req.productionId}/events/${req.eventId}/reqs/${req.id}`)}
                        className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-[#f4f2ec] transition-colors"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-[#182a2a]">{req.title}</span>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            req.status === "in_progress"
                              ? "bg-blue-50 text-blue-500"
                              : "bg-[#eeeee8] text-[#667676]"
                          }`}>
                            {STATUS_LABEL[req.status] ?? req.status}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#a0aeab]">
                          {req.eventTitle} · {req.productionName}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
