import type { Metadata } from "next";
export const metadata: Metadata = { title: "当日 Call Sheet" };

/**
 * Daily call summary page — shows all events the current user has a call for
 * on a given CST date. Linked from the Feishu daily call notification card.
 *
 * URL: /my/daily-call?date=YYYY-MM-DD   (CST date of the events)
 * If no date param, defaults to tomorrow CST.
 */
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { getPool } from "@/lib/pg";

function fmtTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function fmtDateFull(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  const dow = "周" + "日一二三四五六"[d.getUTCDay()];
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${dow}`;
}

/** Parse "YYYY-MM-DD" (CST) into the UTC range that covers that CST day. */
function cstDateToUtcRange(dateStr: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split("-").map(Number);
  // CST 00:00 on date = UTC 16:00 on date-1
  const start = new Date(Date.UTC(y, m - 1, d) - 8 * 3_600_000);
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) };
}

/** Tomorrow's date in CST as "YYYY-MM-DD". */
function tomorrowCSTStr(): string {
  const d = new Date(Date.now() + 8 * 3_600_000);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

type Ctx = { searchParams: Promise<{ date?: string; t?: string }> };

export default async function DailyCallPage({ searchParams }: Ctx) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const { date: dateParam, t: tokenParam } = await searchParams;

  let openId: string;
  if (session) {
    openId = session.openId;
  } else {
    const tokenData = tokenParam ? verifyCardToken(tokenParam, "daily-call") : null;
    if (!tokenData) redirect("/login");
    openId = tokenData.openId;
  }
  const isTokenMode = !session;
  const dateStr = (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) ? dateParam : tomorrowCSTStr();
  const { start, end } = cstDateToUtcRange(dateStr);

  const pool = getPool();

  // All events where user has a call on this CST date
  type EventRow = {
    event_id: string; event_title: string; event_location: string;
    production_id: string; production_name: string;
  };
  const eventsRes = await pool.query<EventRow>(
    `SELECT DISTINCT pe.id AS event_id, pe.title AS event_title,
            pe.location AS event_location,
            pe.production_id, p.name AS production_name
     FROM event_call_time ect
     JOIN production_event pe ON pe.id = ect.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE ect.open_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
     ORDER BY pe.title`,
    [openId, start.toISOString(), end.toISOString()],
  );

  const eventIds = eventsRes.rows.map(r => r.event_id);

  if (eventIds.length === 0) {
    return (
      <div className="min-h-screen bg-zinc-100">
        <div className="max-w-lg mx-auto px-4 pt-8 pb-16">
          <div className="mb-6 flex items-center justify-between">
            {!isTokenMode && <Link href={`/`} className="text-xs text-zinc-400 hover:text-zinc-600">← 返回</Link>}
            <h1 className="text-sm font-bold tracking-[0.15em] text-zinc-400 uppercase">
            当日 Call Sheet <span className="font-normal normal-case text-zinc-300 text-xs">UTC+8</span>
          </h1>
          </div>
          <p className="text-center text-sm text-zinc-300 py-16">{fmtDateFull(`${dateStr}T00:00:00+08:00`)} 暂无 Call</p>
        </div>
      </div>
    );
  }

  // Call times for each event (all participants, not just current user)
  type CallRow = { event_id: string; open_id: string; name: string; call_at: string; notes: string; department_id: string | null };
  const allCallsRes = await pool.query<CallRow>(
    `SELECT event_id, open_id, name, call_at, notes, department_id
     FROM event_call_time WHERE event_id = ANY($1) ORDER BY call_at, name`,
    [eventIds],
  );

  // Schedule items with participants
  type SchedRow = { id: string; event_id: string; title: string; start_time: string | null; end_time: string | null; location: string; order_index: number };
  type PartRow = { item_id: string; name: string };
  const [schedsRes, partsRes] = await Promise.all([
    pool.query<SchedRow>(
      `SELECT id, event_id, title, start_time, end_time, location, order_index
       FROM event_schedule_item WHERE event_id = ANY($1) ORDER BY order_index`,
      [eventIds],
    ),
    pool.query<PartRow>(
      `SELECT sip.item_id, sip.name
       FROM schedule_item_participant sip
       JOIN event_schedule_item esi ON esi.id = sip.item_id
       WHERE esi.event_id = ANY($1)`,
      [eventIds],
    ),
  ]);

  const partByItem = new Map<string, string[]>();
  for (const r of partsRes.rows) {
    if (!partByItem.has(r.item_id)) partByItem.set(r.item_id, []);
    partByItem.get(r.item_id)!.push(r.name);
  }

  // Index by event
  const callsByEvent = new Map<string, CallRow[]>();
  const schedsByEvent = new Map<string, SchedRow[]>();
  for (const r of allCallsRes.rows) {
    if (!callsByEvent.has(r.event_id)) callsByEvent.set(r.event_id, []);
    callsByEvent.get(r.event_id)!.push(r);
  }
  for (const r of schedsRes.rows) {
    if (!schedsByEvent.has(r.event_id)) schedsByEvent.set(r.event_id, []);
    schedsByEvent.get(r.event_id)!.push(r);
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-lg mx-auto px-4 pt-8 pb-16">
        <div className="mb-2 flex items-center justify-between">
          {!isTokenMode && <Link href={`/`} className="text-xs text-zinc-400 hover:text-zinc-600">← 返回</Link>}
          <h1 className="text-sm font-bold tracking-[0.15em] text-zinc-400 uppercase">
            当日 Call Sheet <span className="font-normal normal-case text-zinc-300 text-xs">UTC+8</span>
          </h1>
        </div>
        <p className="text-center text-xs text-zinc-300 mb-6">{fmtDateFull(`${dateStr}T00:00:00+08:00`)}</p>

        <div className="flex flex-col gap-5">
          {eventsRes.rows.map(ev => {
            const myCalls = (callsByEvent.get(ev.event_id) ?? []).filter(c => c.open_id === openId);
            const allCalls = (callsByEvent.get(ev.event_id) ?? []);
            const schedItems = (schedsByEvent.get(ev.event_id) ?? []).sort((a, b) => {
              if (!a.start_time && !b.start_time) return a.order_index - b.order_index;
              if (!a.start_time) return 1;
              if (!b.start_time) return -1;
              return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
            });

            return (
              <div key={ev.event_id} className="bg-white rounded-2xl shadow-sm overflow-hidden">
                {/* Header */}
                <div className="px-5 py-4 border-b border-zinc-50">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-zinc-400">{ev.production_name}</p>
                      <h2 className="text-base font-semibold text-zinc-800 mt-0.5">{ev.event_title}</h2>
                      {ev.event_location && (
                        <p className="text-xs text-zinc-400 mt-0.5">📍 {ev.event_location}</p>
                      )}
                    </div>
                    {!isTokenMode && (
                      <Link
                        href={`/production/${ev.production_id}/events/${ev.event_id}/callsheet`}
                        className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600 mt-1">
                        完整 →
                      </Link>
                    )}
                  </div>

                  {/* My call times */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {myCalls.map((c, i) => (
                      <div key={i} className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5">
                        <span className="text-sm font-mono font-semibold text-amber-600">{fmtTime(c.call_at)}</span>
                        {c.notes && <span className="text-[11px] text-amber-400">{c.notes}</span>}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Schedule */}
                {schedItems.length > 0 && (
                  <div className="px-5 py-3 border-b border-zinc-50">
                    <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">日程</p>
                    <div className="flex flex-col gap-1.5">
                      {schedItems.map(s => {
                        const people = partByItem.get(s.id) ?? [];
                        return (
                          <div key={s.id}>
                            <div className="flex items-baseline gap-2">
                              <span className="shrink-0 font-mono text-xs text-zinc-400 w-10">
                                {s.start_time ? fmtTime(s.start_time) : "—"}
                              </span>
                              <span className="text-sm text-zinc-700">{s.title}</span>
                              {s.location && <span className="text-[11px] text-zinc-300">@ {s.location}</span>}
                            </div>
                            {people.length > 0 && (
                              <p className="text-[11px] text-zinc-400 ml-12 mt-0.5">
                                {people.join("、")}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* All call times */}
                {allCalls.length > 0 && (
                  <div className="px-5 py-3">
                    <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">全组 Call</p>
                    <div className="flex flex-col gap-1">
                      {allCalls.map((c, i) => (
                        <div key={i} className="flex items-baseline gap-2">
                          <span className="shrink-0 font-mono text-xs text-zinc-500 w-10">{fmtTime(c.call_at)}</span>
                          <span className={`text-sm ${c.open_id === openId ? "font-semibold text-zinc-800" : "text-zinc-600"}`}>
                            {c.name}
                          </span>
                          {c.notes && <span className="text-[11px] text-zinc-300">{c.notes}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
