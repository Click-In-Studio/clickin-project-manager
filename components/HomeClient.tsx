"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { fmtCallAt, isoCSTDateStr, todayCSTStr as tzTodayCSTStr, fmtDate } from "@/lib/tz";
import type { MyCallTimeEntry, MyPendingTechReqEntry, MyFollowedEventEntry, UnreadReportEntry } from "@/lib/event-db";

function cstDateStr(iso: string): string { return isoCSTDateStr(iso); }
function todayCSTStr(): string { return tzTodayCSTStr(); }

type Production = { id: string; name: string; createdAt: string };

type Props = {
  productions: Production[];
  isAdmin: boolean;
  currentUser: { name: string; avatarUrl: string | null };
  myCallTimes: MyCallTimeEntry[];
  myPendingReqs: MyPendingTechReqEntry[];
  myFollowedEvents: MyFollowedEventEntry[];
  myUnreadReports: UnreadReportEntry[];
};

function formatCallAt(iso: string): string { return fmtCallAt(iso); }

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练", performance: "演出", meeting: "会议", custom: "其他",
};

export default function HomeClient({ productions: initial, isAdmin, currentUser, myCallTimes, myPendingReqs, myFollowedEvents, myUnreadReports }: Props) {
  const router = useRouter();
  const [productions, setProductions] = useState<Production[]>(initial);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  const deleteProduction = async (id: string) => {
    if (!confirm("确定要删除这个剧本吗？此操作不可撤销。")) return;
    setDeleting(id);
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setProductions((prev) => prev.filter((p) => p.id !== id));
    } catch { /* ignore */ } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center bg-zinc-100 px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        {/* Productions card */}
        <div className="rounded-2xl bg-white px-8 py-8 shadow-sm">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between">
            <h1 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">项目管理器</h1>
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-400">{currentUser.name}</span>
              <form action={`${BASE_PATH}/api/auth/logout`} method="post">
                <button type="submit" className="text-xs text-zinc-300 hover:text-zinc-500 transition-colors">
                  退出
                </button>
              </form>
            </div>
          </div>

          {/* Productions list */}
          {productions.length === 0 && !showInput ? (
            <p className="mb-4 text-center text-xs text-zinc-300">暂无剧本</p>
          ) : (
            <ul className="mb-3 space-y-1">
              {productions.map((p) => (
                <li key={p.id} className="group flex items-center gap-1 rounded-lg hover:bg-zinc-50">
                  <button
                    onClick={() => router.push(`/production/${p.id}`)}
                    className="flex-1 px-3 py-2.5 text-left text-sm text-zinc-700"
                  >
                    {p.name}
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => deleteProduction(p.id)}
                      disabled={deleting === p.id}
                      title="删除剧本"
                      className="shrink-0 rounded px-1.5 py-1 text-[11px] text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-400 disabled:opacity-30 transition-opacity"
                    >
                      删除
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Create new production (admin only) */}
          {isAdmin && (
            showInput ? (
              <>
                <input
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && create()}
                  placeholder="输入剧名"
                  autoFocus
                  className="w-full rounded-lg border border-zinc-200 px-4 py-2.5 text-sm text-zinc-800 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
                />
                {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => { setShowInput(false); setNewName(""); setError(""); }}
                    className="flex-1 rounded-lg border border-zinc-200 py-2.5 text-sm text-zinc-500 hover:border-zinc-400"
                  >
                    取消
                  </button>
                  <button
                    onClick={create}
                    disabled={!newName.trim() || creating}
                    className="flex-1 rounded-lg bg-zinc-800 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-30"
                  >
                    {creating ? "创建中…" : "创建"}
                  </button>
                </div>
              </>
            ) : (
              <button
                onClick={() => setShowInput(true)}
                className="w-full rounded-lg border border-zinc-200 py-2.5 text-sm font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 transition-colors"
              >
                新建剧本
              </button>
            )
          )}
        </div>

        {/* Schedule quick nav — always visible */}
        <div className="grid grid-cols-2 gap-3">
          <Link href={`/my/weekly-call`}
            className="rounded-2xl bg-white px-4 py-5 shadow-sm text-center hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">Weekly</p>
            <p className="text-sm font-medium text-zinc-700">本周安排</p>
          </Link>
          <Link href={`/my/daily-call?date=${todayCSTStr()}`}
            className="rounded-2xl bg-white px-4 py-5 shadow-sm text-center hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">Today</p>
            <p className="text-sm font-medium text-zinc-700">今日 Call</p>
          </Link>
        </div>

        {/* Upcoming call times (within 7 days) */}
        {myCallTimes.length > 0 && (
          <div className="rounded-2xl bg-white px-8 py-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold tracking-[0.15em] text-zinc-400 uppercase">本周我的 Call</h2>
              <Link href={`/my/weekly-call`}
                className="text-[11px] text-zinc-400 hover:text-zinc-600">
                完整安排 →
              </Link>
            </div>
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
                    <span className="text-[11px] font-medium text-zinc-300">{formatCallAt(calls[0].callAt).split(" ")[0]}</span>
                    <Link href={`/my/daily-call?date=${date}`}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600">
                      当日 Call →
                    </Link>
                  </div>
                  <ul className="space-y-1">
                    {calls.map(ct => (
                      <li key={ct.id}>
                        <button
                          onClick={() => router.push(`/production/${ct.productionId}/events/${ct.eventId}/callsheet`)}
                          className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-zinc-50 transition-colors"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-zinc-800">{ct.eventTitle}</span>
                            <span className="shrink-0 text-xs font-mono text-zinc-500">{formatCallAt(ct.callAt)}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-400">
                            <span>{ct.productionName}</span>
                            {ct.eventLocation && <><span>·</span><span>{ct.eventLocation}</span></>}
                            {ct.notes && <><span>·</span><span className="truncate max-w-[120px]">{ct.notes}</span></>}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ));
            })()}
          </div>
        )}

        {/* Followed upcoming events */}
        {myFollowedEvents.length > 0 && (
          <div className="rounded-2xl bg-white px-8 py-6 shadow-sm">
            <h2 className="mb-4 text-xs font-semibold tracking-[0.15em] text-zinc-400 uppercase">我关注的事件</h2>
            <ul className="space-y-2">
              {myFollowedEvents.map(ev => (
                <li key={ev.eventId}>
                  <button
                    onClick={() => router.push(`/production/${ev.productionId}/events/${ev.eventId}`)}
                    className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-zinc-50 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-800">{ev.eventTitle}</span>
                      {ev.startTime && (
                        <span className="shrink-0 text-xs font-mono text-zinc-500">{formatCallAt(ev.startTime)}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-400">
                      <span className="rounded bg-zinc-100 px-1 py-0.5 text-zinc-500">
                        {EVENT_TYPE_LABELS[ev.eventType] ?? ev.eventType}
                      </span>
                      <span>{ev.productionName}</span>
                      {ev.eventLocation && <><span>·</span><span>{ev.eventLocation}</span></>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Unread reports for followed events */}
        {myUnreadReports.length > 0 && (
          <div className="rounded-2xl bg-white px-8 py-6 shadow-sm">
            <h2 className="mb-4 text-xs font-semibold tracking-[0.15em] text-zinc-400 uppercase">未读报告</h2>
            <ul className="space-y-2">
              {myUnreadReports.map(r => (
                <li key={r.reportId}>
                  <button
                    onClick={() => router.push(`/production/${r.productionId}/events/${r.eventId}/reports/${r.reportId}`)}
                    className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-zinc-50 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-800">{r.reportTitle}</span>
                      <span className="shrink-0 text-xs font-mono text-zinc-400">
                        {fmtDate(r.publishedAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-400">
                      {r.eventTitle} · {r.productionName}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pending tech requirements I'm responsible for */}
        {myPendingReqs.length > 0 && (
          <div className="rounded-2xl bg-white px-8 py-6 shadow-sm">
            <h2 className="mb-4 text-xs font-semibold tracking-[0.15em] text-zinc-400 uppercase">我负责的待处理需求</h2>
            <ul className="space-y-2">
              {myPendingReqs.map(req => (
                <li key={req.id}>
                  <button
                    onClick={() => router.push(`/production/${req.productionId}/events/${req.eventId}/reqs`)}
                    className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-zinc-50 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-800">{req.title}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        req.status === "in_progress"
                          ? "bg-blue-50 text-blue-500"
                          : "bg-zinc-100 text-zinc-500"
                      }`}>
                        {STATUS_LABEL[req.status] ?? req.status}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-400">
                      {req.eventTitle} · {req.productionName}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
