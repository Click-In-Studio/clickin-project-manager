import type { Metadata } from "next";
export const metadata: Metadata = { title: "本周 Call 安排" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { getPool } from "@/lib/pg";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";

function cstNow(): Date {
  return new Date(Date.now() + 8 * 3_600_000);
}
function fmtDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
function fmtTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function fmtDow(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return "周" + "日一二三四五六"[d.getUTCDay()];
}

const REQ_STATUS: Record<string, string> = {
  pending: "待处理", in_progress: "进行中",
};

type CallRow = {
  call_at: string; call_notes: string;
  event_id: string; event_title: string; event_location: string;
  production_id: string; production_name: string;
};
type SchedRow = { event_id: string; title: string; start_time: string | null; order_index: number };
type ReqRow = { event_id: string; title: string; status: string };

type Ctx = { searchParams: Promise<{ t?: string }> };

export default async function WeeklyCallPage({ searchParams }: Ctx) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const { t: tokenParam } = await searchParams;

  let openId: string;
  if (session) {
    openId = session.openId;
  } else {
    const tokenData = tokenParam ? verifyCardToken(tokenParam, "weekly-call") : null;
    if (!tokenData) redirect("/login");
    openId = tokenData.openId;
  }
  const isTokenMode = !session;

  const pool = getPool();

  // Week range logic:
  // - Before Sunday 12:00 CST: show this Mon 00:00 CST → next Mon 00:00 CST
  // - After Sunday 12:00 CST (notification already sent): show next Mon → Mon+7
  const now = cstNow(); // UTC+8 values accessible via getUTC*
  const dow = now.getUTCDay(); // 0=Sun … 6=Sat in CST
  const afterSundayNoon = dow === 0 && (now.getUTCHours() > 12 || (now.getUTCHours() === 12 && now.getUTCMinutes() >= 0));
  // Days back to this Monday (Sun=6 days back, Mon=0, Tue=1, ...)
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  // Offset to apply: 0 = this week, +7 = next week
  const weekOffset = afterSundayNoon ? 7 : 0;
  const mondayCSTDate = now.getUTCDate() - daysFromMonday + weekOffset;
  // Monday 00:00 CST in UTC = Date.UTC(y, m, d) - 8h
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), mondayCSTDate) - 8 * 3_600_000);
  const weekEnd   = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);

  const [callsRes, schedRes, reqsRes] = await Promise.all([
    pool.query<CallRow>(
      `SELECT ect.call_at, ect.notes AS call_notes,
              pe.id AS event_id, pe.title AS event_title,
              pe.location AS event_location,
              pe.production_id, p.name AS production_name
       FROM event_call_time ect
       JOIN production_event pe ON pe.id = ect.event_id
       JOIN production p ON p.id = pe.production_id
       WHERE ect.open_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
       ORDER BY ect.call_at`,
      [openId, weekStart.toISOString(), weekEnd.toISOString()],
    ),
    pool.query<SchedRow>(
      `SELECT esi.event_id, esi.title, esi.start_time, esi.order_index
       FROM event_schedule_item esi
       WHERE esi.event_id IN (
         SELECT DISTINCT event_id FROM event_call_time
         WHERE open_id = $1 AND call_at >= $2 AND call_at < $3
       )
       ORDER BY esi.event_id, esi.order_index`,
      [openId, weekStart.toISOString(), weekEnd.toISOString()],
    ),
    pool.query<ReqRow>(
      `SELECT etr.event_id, etr.title, etr.status
       FROM event_tech_req etr
       JOIN event_tech_assignee eta ON eta.req_id = etr.id AND eta.open_id = $1
       WHERE etr.event_id IN (
         SELECT DISTINCT event_id FROM event_call_time
         WHERE open_id = $1 AND call_at >= $2 AND call_at < $3
       ) AND etr.status != 'done'`,
      [openId, weekStart.toISOString(), weekEnd.toISOString()],
    ),
  ]);

  // Group by event
  type EventGroup = {
    eventId: string; eventTitle: string; eventLocation: string;
    productionId: string; productionName: string;
    calls: { callAt: string; notes: string }[];
    schedItems: { title: string; startTime: string | null }[];
    myReqs: { title: string; status: string }[];
  };
  const byEvent = new Map<string, EventGroup>();
  for (const r of callsRes.rows) {
    if (!byEvent.has(r.event_id)) {
      byEvent.set(r.event_id, {
        eventId: r.event_id, eventTitle: r.event_title,
        eventLocation: r.event_location, productionId: r.production_id,
        productionName: r.production_name, calls: [], schedItems: [], myReqs: [],
      });
    }
    byEvent.get(r.event_id)!.calls.push({ callAt: r.call_at, notes: r.call_notes });
  }
  for (const r of schedRes.rows) byEvent.get(r.event_id)?.schedItems.push({ title: r.title, startTime: r.start_time });
  for (const r of reqsRes.rows) byEvent.get(r.event_id)?.myReqs.push({ title: r.title, status: r.status });

  const events = [...byEvent.values()];

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-lg mx-auto px-4 pt-8 pb-16">
        <div className="mb-6 flex items-center justify-between">
          {!isTokenMode && <Link href={`/`} className="text-xs text-zinc-400 hover:text-zinc-600">← 返回</Link>}
          <h1 className="text-sm font-bold tracking-[0.15em] text-zinc-400 uppercase">
            本周 Call 安排 <span className="font-normal normal-case text-zinc-300 text-xs">UTC+8</span>
          </h1>
        </div>

        {events.length === 0 ? (
          <p className="text-center text-sm text-zinc-300 py-16">本周暂无 Call</p>
        ) : (
          <div className="flex flex-col gap-5">
            {events.map(ev => (
              <div key={ev.eventId} className="bg-white rounded-2xl shadow-sm overflow-hidden">
                {/* Event header */}
                <div className="px-5 py-4 border-b border-zinc-50">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-zinc-400">{ev.productionName}</p>
                      <h2 className="text-base font-semibold text-zinc-800 mt-0.5">{ev.eventTitle}</h2>
                      {ev.eventLocation && (
                        <p className="text-xs text-zinc-400 mt-0.5">📍 {ev.eventLocation}</p>
                      )}
                    </div>
                    {!isTokenMode && (
                      <Link
                        href={`/production/${ev.productionId}/events/${ev.eventId}/callsheet`}
                        className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600 mt-1">
                        Call Sheet →
                      </Link>
                    )}
                  </div>

                  {/* My call times */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {ev.calls.map((c, i) => (
                      <div key={i} className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5">
                        <span className="text-sm font-mono font-semibold text-amber-600">{fmtTime(c.callAt)}</span>
                        <span className="text-[11px] text-amber-500">{fmtDow(c.callAt)} {fmtDate(c.callAt)}</span>
                        {c.notes && <><span className="text-[11px] text-amber-400">· </span><SmartText content={c.notes} plugins={[scriptRefTextPlugin]} className="text-[11px] text-amber-400" /></>}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Schedule */}
                {ev.schedItems.length > 0 && (
                  <div className="px-5 py-3 border-b border-zinc-50">
                    <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">日程</p>
                    <div className="flex flex-col gap-1">
                      {ev.schedItems.map((s, i) => (
                        <div key={i} className="flex items-baseline gap-2">
                          <span className="shrink-0 font-mono text-xs text-zinc-400 w-10">
                            {s.startTime ? fmtTime(s.startTime) : "—"}
                          </span>
                          <span className="text-sm text-zinc-700">{s.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* My pending tech reqs */}
                {ev.myReqs.length > 0 && (
                  <div className="px-5 py-3">
                    <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">我负责的需求</p>
                    <div className="flex flex-col gap-1.5">
                      {ev.myReqs.map((r, i) => (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <span className="text-sm text-zinc-700">{r.title}</span>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            r.status === "in_progress" ? "bg-blue-50 text-blue-500" : "bg-zinc-100 text-zinc-500"
                          }`}>{REQ_STATUS[r.status] ?? r.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
