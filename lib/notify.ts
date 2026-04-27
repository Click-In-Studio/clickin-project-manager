/**
 * Notification dispatch: weekly call, daily call, report.
 * Also manages the notification_job table for scheduled daily-call sends.
 */

import { getPool } from "./pg";
import { BASE_PATH } from "./base-path";
import {
  sendCard, buildWeeklyCallCard, buildDailyCallCard, buildReportCard,
  type WeeklyCallEntry, type DailyCallScheduleItem,
} from "./feishu-bot";

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000") + BASE_PATH;
}

// ─── Job table helpers ────────────────────────────────────────────────────────

/** Schedules or re-schedules the daily-call job for an event. */
export async function upsertDailyCallJob(eventId: string, scheduledAt: Date): Promise<void> {
  const id = `dcall_${eventId}`;
  await getPool().query(
    `INSERT INTO notification_job (id, type, event_id, scheduled_at)
     VALUES ($1, 'daily_call', $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET scheduled_at = EXCLUDED.scheduled_at,
           processed_at = NULL,
           error        = NULL`,
    [id, eventId, scheduledAt.toISOString()],
  );
}

export async function listDueNotificationJobs(): Promise<{ id: string; eventId: string }[]> {
  const res = await getPool().query<{ id: string; event_id: string }>(
    `SELECT id, event_id FROM notification_job
     WHERE scheduled_at <= now() AND processed_at IS NULL
     ORDER BY scheduled_at`,
  );
  return res.rows.map(r => ({ id: r.id, eventId: r.event_id }));
}

export async function markJobProcessed(id: string, error?: string): Promise<void> {
  await getPool().query(
    `UPDATE notification_job SET processed_at = now(), error = $2 WHERE id = $1`,
    [id, error ?? null],
  );
}

// ─── Trigger helpers (called from event/report API routes) ───────────────────

/**
 * When an event's startTime is set or changed, compute the daily-call trigger
 * time (D-1 at 12:00 CST = D-1 at 04:00 UTC). If already past, dispatch
 * immediately; otherwise store as a scheduled job.
 */
export async function scheduleOrDispatchDailyCall(eventId: string, startTime: string | null): Promise<void> {
  if (!startTime) return;
  const notifyAt = computeDailyCallTime(startTime);
  if (notifyAt <= new Date()) {
    // Past trigger time — fire immediately (non-blocking)
    dispatchDailyCallForEvent(eventId).catch(e =>
      console.error("[notify] immediate daily call failed:", e),
    );
  } else {
    await upsertDailyCallJob(eventId, notifyAt);
  }
}

/** Computes D-1 at 12:00 CST (= 04:00 UTC) for a given startTime ISO string. */
function computeDailyCallTime(startTime: string): Date {
  // Convert to CST date first — startTime may be e.g. "2026-04-28T16:00Z" (= 04/29 00:00 CST),
  // so using UTC date directly would give D-1 off by one day.
  const cst = new Date(new Date(startTime).getTime() + 8 * 3_600_000);
  const y = cst.getUTCFullYear();
  const m = cst.getUTCMonth();
  const d = cst.getUTCDate();
  // D-1 at 12:00 CST = D-1 at 04:00 UTC
  return new Date(Date.UTC(y, m, d - 1, 4, 0, 0, 0));
}

// ─── Weekly call dispatch ─────────────────────────────────────────────────────

/**
 * Called by the cron endpoint (Sunday 12:00 CST).
 * Queries all users who have at least one call in the coming week,
 * then sends a card to each.
 */
export type DispatchResult = {
  sent: number;
  errors: string[];
  dryCards?: { openId: string; card: object }[];
};

export async function dispatchWeeklyCall(dryRun = false): Promise<DispatchResult> {
  const pool = getPool();
  const base = appBaseUrl();

  // Coming week: tomorrow 00:00 UTC → +7 days (approximates Mon–Sun CST)
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() + 1);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3600_000);

  // All distinct users with calls in the coming week
  const usersRes = await pool.query<{ open_id: string }>(
    `SELECT DISTINCT open_id FROM event_call_time
     WHERE call_at >= $1 AND call_at < $2`,
    [weekStart.toISOString(), weekEnd.toISOString()],
  );

  const weeklyUrl = `${base}/my/weekly-call`;

  let sent = 0;
  const errors: string[] = [];
  const dryCards: { openId: string; card: object }[] = [];

  for (const { open_id } of usersRes.rows) {
    try {
      const entries = await getWeeklyCallDataForUser(open_id, weekStart, weekEnd);
      if (!entries.length) continue;
      const card = buildWeeklyCallCard(entries, weeklyUrl);
      if (dryRun) {
        dryCards.push({ openId: open_id, card });
      } else {
        await sendCard(open_id, card);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${open_id}: ${msg}`);
      console.error("[notify] weekly call error for", open_id, e);
    }
  }

  return { sent, errors, ...(dryRun ? { dryCards } : {}) };
}

async function getWeeklyCallDataForUser(
  openId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<WeeklyCallEntry[]> {
  const pool = getPool();

  // Call times for this user in the window, with event info
  const callsRes = await pool.query<{
    call_at: string; call_notes: string;
    event_id: string; event_title: string; event_location: string; production_id: string;
  }>(
    `SELECT ect.call_at, ect.notes AS call_notes,
            pe.id AS event_id, pe.title AS event_title,
            pe.location AS event_location, pe.production_id
     FROM event_call_time ect
     JOIN production_event pe ON pe.id = ect.event_id
     WHERE ect.open_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
     ORDER BY ect.call_at`,
    [openId, weekStart.toISOString(), weekEnd.toISOString()],
  );

  if (!callsRes.rows.length) return [];

  const eventIds = [...new Set(callsRes.rows.map(r => r.event_id))];

  // Schedule items for those events (ordered)
  const schedRes = await pool.query<{ event_id: string; title: string; start_time: string | null }>(
    `SELECT event_id, title, start_time FROM event_schedule_item
     WHERE event_id = ANY($1) ORDER BY event_id, order_index`,
    [eventIds],
  );

  // Pending tech reqs assigned to this user in those events
  const reqsRes = await pool.query<{ event_id: string; title: string }>(
    `SELECT etr.event_id, etr.title
     FROM event_tech_req etr
     JOIN event_tech_assignee eta ON eta.req_id = etr.id AND eta.open_id = $1
     WHERE etr.event_id = ANY($2) AND etr.status != 'done'`,
    [openId, eventIds],
  );

  const schedByEvent = new Map<string, { title: string; startTime: string | null }[]>();
  for (const r of schedRes.rows) {
    if (!schedByEvent.has(r.event_id)) schedByEvent.set(r.event_id, []);
    schedByEvent.get(r.event_id)!.push({ title: r.title, startTime: r.start_time });
  }

  const reqsByEvent = new Map<string, { title: string }[]>();
  for (const r of reqsRes.rows) {
    if (!reqsByEvent.has(r.event_id)) reqsByEvent.set(r.event_id, []);
    reqsByEvent.get(r.event_id)!.push({ title: r.title });
  }

  return callsRes.rows.map(r => ({
    callAt: r.call_at,
    callNotes: r.call_notes,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventLocation: r.event_location,
    productionId: r.production_id,
    scheduleItems: schedByEvent.get(r.event_id) ?? [],
    myTechReqs: reqsByEvent.get(r.event_id) ?? [],
  }));
}

// ─── Daily call dispatch ──────────────────────────────────────────────────────

/**
 * Sends a daily call card to every person who has a call time in this event.
 * Skips if no one has a call time.
 */
export async function dispatchDailyCallForEvent(eventId: string, dryRun = false): Promise<DispatchResult> {
  const pool = getPool();
  const base = appBaseUrl();

  // Get event info
  const eventRes = await pool.query<{
    id: string; title: string; location: string; start_time: string | null; production_id: string;
  }>(
    `SELECT id, title, location, start_time, production_id FROM production_event WHERE id = $1`,
    [eventId],
  );
  const event = eventRes.rows[0];
  if (!event || !event.start_time) return { sent: 0, errors: [] };

  // All call times for this event, ordered
  const callsRes = await pool.query<{
    open_id: string; name: string; call_at: string; notes: string;
  }>(
    `SELECT open_id, name, call_at, notes FROM event_call_time WHERE event_id = $1 ORDER BY call_at`,
    [eventId],
  );
  if (!callsRes.rows.length) return { sent: 0, errors: [] };

  // Schedule items with participants
  const itemsRes = await pool.query<{ id: string; title: string; start_time: string | null; end_time: string | null; location: string }>(
    `SELECT id, title, start_time, end_time, location FROM event_schedule_item WHERE event_id = $1 ORDER BY order_index`,
    [eventId],
  );
  const partRes = await pool.query<{ item_id: string; name: string }>(
    `SELECT sip.item_id, sip.name FROM schedule_item_participant sip
     JOIN event_schedule_item esi ON esi.id = sip.item_id WHERE esi.event_id = $1`,
    [eventId],
  );
  const partByItem = new Map<string, string[]>();
  for (const r of partRes.rows) {
    if (!partByItem.has(r.item_id)) partByItem.set(r.item_id, []);
    partByItem.get(r.item_id)!.push(r.name);
  }
  const scheduleItems: DailyCallScheduleItem[] = itemsRes.rows.map(r => ({
    title: r.title,
    startTime: r.start_time,
    participants: partByItem.get(r.id) ?? [],
  }));

  const allCalls = callsRes.rows.map(r => ({ name: r.name, callAt: r.call_at, callNotes: r.notes }));
  // CST date string "YYYY-MM-DD" for the event's start day
  const cstDate = new Date(new Date(event.start_time).getTime() + 8 * 3_600_000);
  const dateStr = `${cstDate.getUTCFullYear()}-${String(cstDate.getUTCMonth() + 1).padStart(2, "0")}-${String(cstDate.getUTCDate()).padStart(2, "0")}`;
  const callsheetUrl = `${base}/my/daily-call?date=${dateStr}`;

  let sent = 0;
  const errors: string[] = [];
  const dryCards: { openId: string; card: object }[] = [];

  const seen = new Set<string>();
  for (const row of callsRes.rows) {
    if (seen.has(row.open_id)) continue;
    seen.add(row.open_id);
    try {
      const card = buildDailyCallCard(
        event.title, event.location, event.start_time,
        row.call_at, row.notes,
        scheduleItems, allCalls, callsheetUrl,
      );
      if (dryRun) {
        dryCards.push({ openId: row.open_id, card });
      } else {
        await sendCard(row.open_id, card);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${row.open_id}: ${msg}`);
      console.error("[notify] daily call error for", row.open_id, e);
    }
  }

  return { sent, errors, ...(dryRun ? { dryCards } : {}) };
}

// ─── Report dispatch ──────────────────────────────────────────────────────────

/**
 * Sends a report card to all event followers + everyone with a call time in
 * this event. Deduplicates by open_id.
 */
export async function dispatchReportNotification(
  reportId: string,
  eventId: string,
  productionId: string,
  dryRun = false,
): Promise<DispatchResult> {
  const pool = getPool();
  const base = appBaseUrl();

  // Report content
  const rptRes = await pool.query<{ title: string; body: string; published_at: string; event_id: string }>(
    `SELECT title, body, published_at FROM event_report WHERE id = $1`,
    [reportId],
  );
  const report = rptRes.rows[0];
  if (!report || !report.published_at) return { sent: 0, errors: [] };

  // Event title + department notes
  const [evRes, notesRes] = await Promise.all([
    pool.query<{ title: string }>(
      `SELECT title FROM production_event WHERE id = $1`,
      [eventId],
    ),
    pool.query<{ dept_name: string; content: string }>(
      `SELECT ed.name AS dept_name, ern.content
       FROM event_report_note ern
       JOIN event_department ed ON ed.id = ern.department_id
       WHERE ern.report_id = $1
       ORDER BY ed.display_order, ern.created_at`,
      [reportId],
    ),
  ]);
  const eventTitle = evRes.rows[0]?.title ?? "";
  const notes = notesRes.rows.map(r => ({ deptName: r.dept_name, content: r.content }));

  // Recipients: followers ∪ call-time participants, deduped
  const recipRes = await pool.query<{ open_id: string }>(
    `SELECT DISTINCT open_id FROM (
       SELECT open_id FROM event_participant WHERE event_id = $1
       UNION
       SELECT open_id FROM event_call_time WHERE event_id = $1
     ) AS r`,
    [eventId],
  );
  if (!recipRes.rows.length) return { sent: 0, errors: [] };

  const url = `${base}/production/${productionId}/events/${eventId}/reports/${reportId}`;
  const card = buildReportCard(report.title, eventTitle, report.body, notes, report.published_at, url);

  let sent = 0;
  const errors: string[] = [];
  const dryCards: { openId: string; card: object }[] = [];

  for (const { open_id } of recipRes.rows) {
    try {
      if (dryRun) {
        dryCards.push({ openId: open_id, card });
      } else {
        await sendCard(open_id, card);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${open_id}: ${msg}`);
      console.error("[notify] report error for", open_id, e);
    }
  }

  return { sent, errors, ...(dryRun ? { dryCards } : {}) };
}
