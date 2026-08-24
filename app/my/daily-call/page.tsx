import type { Metadata } from "next";
import type { CSSProperties } from "react";
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
import SmartText from "@/components/SmartText";

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

const rule: CSSProperties = { border: "none", borderTop: "1px solid var(--line)", margin: 0 };
const sectionBar: CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase",
  color: "var(--muted)", padding: "10px 0", margin: 0,
};

type Ctx = { searchParams: Promise<{ date?: string; t?: string }> };

export default async function DailyCallPage({ searchParams }: Ctx) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const { date: dateParam, t: tokenParam } = await searchParams;

  let userId: string;
  if (session) {
    userId = session.userId;
  } else {
    const tokenData = tokenParam ? verifyCardToken(tokenParam, "daily-call") : null;
    if (!tokenData) redirect("/login");
    userId = tokenData.userId;
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
     WHERE ect.user_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
     ORDER BY pe.title`,
    [userId, start.toISOString(), end.toISOString()],
  );

  const eventIds = eventsRes.rows.map(r => r.event_id);

  // Call times for each event (all participants, not just current user)
  type CallRow = { event_id: string; user_id: string; name: string; call_at: string; notes: string; department_id: string | null };
  type SchedRow = { id: string; event_id: string; title: string; start_time: string | null; end_time: string | null; location: string; order_index: number };
  type PartRow = { item_id: string; name: string };

  const callsByEvent = new Map<string, CallRow[]>();
  const schedsByEvent = new Map<string, SchedRow[]>();
  const partByItem = new Map<string, string[]>();

  if (eventIds.length > 0) {
    const [allCallsRes, schedsRes, partsRes] = await Promise.all([
      pool.query<CallRow>(
        `SELECT event_id, user_id, name, call_at, notes, department_id
         FROM event_call_time WHERE event_id = ANY($1) ORDER BY call_at, name`,
        [eventIds],
      ),
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

    for (const r of partsRes.rows) {
      if (!partByItem.has(r.item_id)) partByItem.set(r.item_id, []);
      partByItem.get(r.item_id)!.push(r.name);
    }
    for (const r of allCallsRes.rows) {
      if (!callsByEvent.has(r.event_id)) callsByEvent.set(r.event_id, []);
      callsByEvent.get(r.event_id)!.push(r);
    }
    for (const r of schedsRes.rows) {
      if (!schedsByEvent.has(r.event_id)) schedsByEvent.set(r.event_id, []);
      schedsByEvent.get(r.event_id)!.push(r);
    }
  }

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>

      {/* Eyebrow + nav link */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", margin: 0 }}>
          Daily Call Sheet · UTC+8
        </p>
        {!isTokenMode && (
          <Link href="/my/weekly-call" style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}>
            ← 本周日程
          </Link>
        )}
      </div>

      {/* Date heading */}
      <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", margin: "0 0 20px" }}>
        {fmtDateFull(`${dateStr}T00:00:00+08:00`)}
      </h1>

      {eventIds.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "48px 0" }}>暂无 Call 安排</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {eventsRes.rows.map(ev => {
            const myCalls = (callsByEvent.get(ev.event_id) ?? []).filter(c => c.user_id === userId);
            const allCalls = callsByEvent.get(ev.event_id) ?? [];
            const schedItems = (schedsByEvent.get(ev.event_id) ?? []).slice().sort((a, b) => {
              if (!a.start_time && !b.start_time) return a.order_index - b.order_index;
              if (!a.start_time) return 1;
              if (!b.start_time) return -1;
              return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
            });

            return (
              <div key={ev.event_id} style={{ background: "white", border: "1px solid var(--line)", borderRadius: 12, padding: "24px 28px" }}>

                {/* Event title block */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
                  <div>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 4px" }}>{ev.production_name}</p>
                    <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em", margin: 0, lineHeight: 1.2 }}>
                      {ev.event_title}
                    </h2>
                    {ev.event_location && (
                      <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{ev.event_location}</p>
                    )}
                  </div>
                  {!isTokenMode && (
                    <Link
                      href={`/production/${ev.production_id}/events/${ev.event_id}/callsheet`}
                      style={{ flexShrink: 0, fontSize: 11, color: "var(--muted)", textDecoration: "none", paddingTop: 4 }}
                    >
                      完整 →
                    </Link>
                  )}
                </div>

                {/* My call times */}
                {myCalls.length > 0 && (
                  <>
                    <hr style={rule} />
                    <p style={sectionBar}>我的 Call</p>
                    <hr style={rule} />
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0" }}>
                      {myCalls.map((c, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: 8, background: "#fffbeb", padding: "6px 10px" }}>
                          <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#d97706", fontSize: 14 }}>{fmtTime(c.call_at)}</span>
                          {c.notes && (
                            <SmartText content={c.notes} className="text-[11px] text-amber-400" />
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Schedule items */}
                {schedItems.length > 0 && (
                  <>
                    <hr style={rule} />
                    <p style={sectionBar}>事件流程</p>
                    <hr style={rule} />
                    {schedItems.map(s => {
                      const people = partByItem.get(s.id) ?? [];
                      return (
                        <div key={s.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--line)" }}>
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{s.title}</span>
                              {s.location && (
                                <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{s.location}</p>
                              )}
                              {people.length > 0 && (
                                <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{people.join("、")}</p>
                              )}
                            </div>
                            {s.start_time && (
                              <span style={{ flexShrink: 0, fontSize: 12, color: "var(--muted)", fontFamily: "monospace" }}>
                                {fmtTime(s.start_time)}
                                {s.end_time && s.end_time !== s.start_time && (
                                  <span style={{ color: "var(--line)" }}> – {fmtTime(s.end_time)}</span>
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}

                {/* All call times */}
                {allCalls.length > 0 && (
                  <>
                    <hr style={rule} />
                    <p style={sectionBar}>全组 Call</p>
                    <hr style={rule} />
                    {allCalls.map((c, i) => (
                      <div key={i} style={{ padding: "11px 0", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 16 }}>
                        <span style={{ flexShrink: 0, fontFamily: "monospace", fontSize: 13, color: "var(--muted)", minWidth: 44 }}>
                          {fmtTime(c.call_at)}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: c.user_id === userId ? 700 : 400, color: c.user_id === userId ? "var(--ink)" : "var(--muted)" }}>
                          {c.name}
                        </span>
                        {c.notes && (
                          <SmartText content={c.notes} className="text-[11px] text-zinc-300" />
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
