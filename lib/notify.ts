/**
 * Notification dispatch: weekly call, daily call, report, mentions.
 *
 * All sends go through the platform-agnostic CommunicationPlatform adapter.
 * PlatformMessage.richContent carries the Feishu card JSON; adapters on other
 * platforms compile richContent into their own format (HTML, Block Kit, etc.).
 */

import { getPool } from "./pg";
import { BASE_PATH } from "./base-path";
import {
  buildWeeklyCallCard, buildDailyCallCard, buildReportCard, buildMentionCard,
  type WeeklyCallEntry, type DailyCallScheduleItem,
} from "./feishu-bot";
import { listAllReportMentionedUserIds } from "./event-db";
import { createCardToken } from "./card-token";
import { getOptedOutUsers } from "./notification-prefs";
import { resolveNotificationTarget, batchResolveNotificationTargets } from "./platform/notification-router";
import type { PlatformMessage } from "./platform/types";

// ─── Result type ──────────────────────────────────────────────────────────────

export type DispatchResult = {
  sent: number;
  errors: string[];
  dryMessages?: { platformUserId: string; platformId: string; message: PlatformMessage }[];
};

// ─── Weekly call dispatch ─────────────────────────────────────────────────────

export async function dispatchWeeklyCall(dryRun = false): Promise<DispatchResult> {
  const pool = getPool();

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() + 1);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3600_000);

  const usersRes = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM event_call_time
     WHERE call_at >= $1 AND call_at < $2`,
    [weekStart.toISOString(), weekEnd.toISOString()],
  );

  const userIds = usersRes.rows.map((r) => r.user_id);
  const targets = await batchResolveNotificationTargets(userIds);
  const weeklyOptedOut = await getOptedOutUsers("weekly_call");
  const weeklyTokenExp = new Date(Date.now() + 8 * 24 * 3_600_000);

  let sent = 0;
  const errors: string[] = [];
  const dryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  for (const { user_id } of usersRes.rows) {
    if (weeklyOptedOut.has(user_id)) continue;
    const target = targets.get(user_id);
    if (!target) continue;
    try {
      const entries = await getWeeklyCallDataForUser(user_id, weekStart, weekEnd);
      if (!entries.length) continue;
      const token = createCardToken(user_id, "weekly-call", weeklyTokenExp);
      const actionUrl = target.adapter.buildActionUrl(`${BASE_PATH}/my/weekly-call/${token}`);
      console.log("[notify] weekly action url for", target.platformUserId, actionUrl);
      const card = buildWeeklyCallCard(entries, actionUrl);
      const message: PlatformMessage = {
        text: `你本周有 ${entries.length} 场 Call，点击查看：${actionUrl}`,
        title: "本周 Call 安排",
        primaryUrl: actionUrl,
        richContent: card,
      };
      console.log("[notify] weekly richContent:", JSON.stringify(card));
      if (dryRun) {
        dryMessages.push({ platformUserId: target.platformUserId, platformId: target.platformId, message });
      } else {
        await target.adapter.sendDirectMessage(target.platformUserId, message);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${target.platformUserId}: ${msg}`);
      console.error("[notify] weekly call error for", target.platformUserId, e);
    }
  }

  return { sent, errors, ...(dryRun ? { dryMessages } : {}) };
}

async function getWeeklyCallDataForUser(
  userId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<WeeklyCallEntry[]> {
  const pool = getPool();

  const callsRes = await pool.query<{
    call_at: string; call_notes: string;
    event_id: string; event_title: string; event_location: string; production_id: string;
  }>(
    `SELECT ect.call_at, ect.notes AS call_notes,
            pe.id AS event_id, pe.title AS event_title,
            pe.location AS event_location, pe.production_id
     FROM event_call_time ect
     JOIN production_event pe ON pe.id = ect.event_id
     WHERE ect.user_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
     ORDER BY ect.call_at`,
    [userId, weekStart.toISOString(), weekEnd.toISOString()],
  );

  if (!callsRes.rows.length) return [];

  const eventIds = [...new Set(callsRes.rows.map((r) => r.event_id))];

  const [schedRes, reqsRes] = await Promise.all([
    pool.query<{ event_id: string; title: string; start_time: string | null }>(
      `SELECT event_id, title, start_time FROM event_schedule_item
       WHERE event_id = ANY($1) ORDER BY event_id, order_index`,
      [eventIds],
    ),
    pool.query<{ event_id: string; title: string }>(
      `SELECT etr.event_id, etr.title
       FROM event_tech_req etr
       JOIN event_tech_assignee eta ON eta.req_id = etr.id AND eta.user_id = $1
       WHERE etr.event_id = ANY($2) AND etr.status != 'done'`,
      [userId, eventIds],
    ),
  ]);

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

  return callsRes.rows.map((r) => ({
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

// ─── Daily call sweep ─────────────────────────────────────────────────────────

export async function dispatchDailyCallsForToday(dryRun = false): Promise<{
  total: number;
  events: { eventId: string; sent: number; errors: string[] }[];
  dryMessages?: { platformUserId: string; platformId: string; message: PlatformMessage }[];
}> {
  const pool = getPool();

  const nowCst = new Date(Date.now() + 8 * 3_600_000);
  const y = nowCst.getUTCFullYear(), mo = nowCst.getUTCMonth(), d = nowCst.getUTCDate();
  const windowStart = new Date(Date.UTC(y, mo, d + 1, -8, 0, 0));
  const windowEnd   = new Date(Date.UTC(y, mo, d + 2, -8, 0, 0));

  const evRes = await pool.query<{ event_id: string }>(
    `SELECT DISTINCT ect.event_id
     FROM event_call_time ect
     JOIN production_event pe ON pe.id = ect.event_id
     WHERE pe.status = 'published'
       AND ect.call_at >= $1 AND ect.call_at < $2`,
    [windowStart.toISOString(), windowEnd.toISOString()],
  );

  let total = 0;
  const events: { eventId: string; sent: number; errors: string[] }[] = [];
  const allDryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  for (const { event_id } of evRes.rows) {
    const result = await dispatchDailyCallForEvent(event_id, dryRun);
    total += result.sent;
    events.push({ eventId: event_id, sent: result.sent, errors: result.errors });
    if (dryRun && result.dryMessages) allDryMessages.push(...result.dryMessages);
  }

  return { total, events, ...(dryRun ? { dryMessages: allDryMessages } : {}) };
}

export async function maybeSendLatePublishDailyCall(eventId: string): Promise<void> {
  const nowCst = new Date(Date.now() + 8 * 3_600_000);
  if (nowCst.getUTCHours() < 12) return;

  const y = nowCst.getUTCFullYear(), mo = nowCst.getUTCMonth(), d = nowCst.getUTCDate();
  const windowStart = new Date(Date.UTC(y, mo, d + 1, -8, 0, 0));
  const windowEnd   = new Date(Date.UTC(y, mo, d + 2, -8, 0, 0));

  const pool = getPool();
  const res = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_call_time WHERE event_id = $1 AND call_at >= $2 AND call_at < $3
     ) AS exists`,
    [eventId, windowStart.toISOString(), windowEnd.toISOString()],
  );
  if (!res.rows[0].exists) return;

  await dispatchDailyCallForEvent(eventId);
}

export async function dispatchDailyCallForEvent(eventId: string, dryRun = false): Promise<DispatchResult> {
  const pool = getPool();

  const eventRes = await pool.query<{
    id: string; title: string; location: string; start_time: string | null; production_id: string;
  }>(
    `SELECT id, title, location, start_time, production_id FROM production_event WHERE id = $1`,
    [eventId],
  );
  const event = eventRes.rows[0];
  if (!event || !event.start_time) return { sent: 0, errors: [] };

  const callsRes = await pool.query<{
    user_id: string; name: string; call_at: string; notes: string;
  }>(
    `SELECT user_id, name, call_at, notes
     FROM event_call_time
     WHERE event_id = $1 ORDER BY call_at`,
    [eventId],
  );
  if (!callsRes.rows.length) return { sent: 0, errors: [] };

  const [itemsRes, partRes] = await Promise.all([
    pool.query<{ id: string; title: string; start_time: string | null }>(
      `SELECT id, title, start_time FROM event_schedule_item WHERE event_id = $1 ORDER BY order_index`,
      [eventId],
    ),
    pool.query<{ item_id: string; name: string }>(
      `SELECT sip.item_id, sip.name FROM schedule_item_participant sip
       JOIN event_schedule_item esi ON esi.id = sip.item_id WHERE esi.event_id = $1`,
      [eventId],
    ),
  ]);

  const partByItem = new Map<string, string[]>();
  for (const r of partRes.rows) {
    if (!partByItem.has(r.item_id)) partByItem.set(r.item_id, []);
    partByItem.get(r.item_id)!.push(r.name);
  }
  const scheduleItems: DailyCallScheduleItem[] = itemsRes.rows.map((r) => ({
    title: r.title,
    startTime: r.start_time,
    participants: partByItem.get(r.id) ?? [],
  }));

  const allCalls = callsRes.rows.map((r) => ({ name: r.name, callAt: r.call_at, callNotes: r.notes }));
  const cstDate = new Date(new Date(event.start_time).getTime() + 8 * 3_600_000);
  const dateStr = `${cstDate.getUTCFullYear()}-${String(cstDate.getUTCMonth() + 1).padStart(2, "0")}-${String(cstDate.getUTCDate()).padStart(2, "0")}`;
  const dailyTokenExp = new Date(Date.UTC(
    cstDate.getUTCFullYear(), cstDate.getUTCMonth(), cstDate.getUTCDate() + 1, 4, 0, 0, 0,
  ));

  const distinctUserIds = [...new Set(callsRes.rows.map((r) => r.user_id))];
  const targets = await batchResolveNotificationTargets(distinctUserIds, event.production_id);
  const dailyOptedOut = await getOptedOutUsers("daily_call");

  let sent = 0;
  const errors: string[] = [];
  const dryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  const seen = new Set<string>();
  for (const row of callsRes.rows) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    if (dailyOptedOut.has(row.user_id)) continue;
    const target = targets.get(row.user_id);
    if (!target) continue;
    try {
      const token = createCardToken(row.user_id, "daily-call", dailyTokenExp);
      const actionUrl = target.adapter.buildActionUrl(`${BASE_PATH}/my/daily-call/${dateStr}/${token}`);
      console.log("[notify] daily action url for", target.platformUserId, actionUrl);
      const card = buildDailyCallCard(
        event.title, event.location, event.start_time,
        row.call_at, row.notes,
        scheduleItems, allCalls, actionUrl,
      );
      const message: PlatformMessage = {
        text: `明日 Call — ${event.title}，你的 Call 时间：${row.call_at}，查看：${actionUrl}`,
        title: `明日 Call Sheet — ${event.title}`,
        primaryUrl: actionUrl,
        richContent: card,
      };
      console.log("[notify] daily richContent:", JSON.stringify(card));
      if (dryRun) {
        dryMessages.push({ platformUserId: target.platformUserId, platformId: target.platformId, message });
      } else {
        await target.adapter.sendDirectMessage(target.platformUserId, message);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${target.platformUserId}: ${msg}`);
      console.error("[notify] daily call error for", target.platformUserId, e);
    }
  }

  return { sent, errors, ...(dryRun ? { dryMessages } : {}) };
}

// ─── Report dispatch ──────────────────────────────────────────────────────────

export async function dispatchReportNotification(
  reportId: string,
  eventId: string,
  productionId: string,
  dryRun = false,
): Promise<DispatchResult> {
  const pool = getPool();

  const rptRes = await pool.query<{ title: string; body: string; published_at: string }>(
    `SELECT title, body, published_at FROM event_report WHERE id = $1`,
    [reportId],
  );
  const report = rptRes.rows[0];
  if (!report || !report.published_at) return { sent: 0, errors: [] };

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
  const notes = notesRes.rows.map((r) => ({ deptName: r.dept_name, content: r.content }));

  const recipRes = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM event_participant WHERE event_id = $1
       UNION
       SELECT user_id FROM event_call_time WHERE event_id = $1
     ) sub`,
    [eventId],
  );
  if (!recipRes.rows.length) return { sent: 0, errors: [] };

  const userIds = recipRes.rows.map((r) => r.user_id);
  const targets = await batchResolveNotificationTargets(userIds, productionId);
  const reportOptedOut = await getOptedOutUsers("report_broadcast");
  const reportBasePath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reports/${reportId}`;
  const reportTokenExp = new Date(Date.now() + 30 * 24 * 3_600_000);

  let sent = 0;
  const errors: string[] = [];
  const dryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  for (const { user_id } of recipRes.rows) {
    if (reportOptedOut.has(user_id)) continue;
    const target = targets.get(user_id);
    if (!target) continue;
    try {
      const token = createCardToken(user_id, `report:${reportId}`, reportTokenExp);
      const actionUrl = target.adapter.buildActionUrl(`${reportBasePath}/${token}`);
      console.log("[notify] report action url for", target.platformUserId, actionUrl);
      const card = buildReportCard(report.title, eventTitle, report.body, notes, report.published_at, actionUrl);
      const message: PlatformMessage = {
        text: `新报告：${report.title}（${eventTitle}），查看：${actionUrl}`,
        title: `新报告 — ${report.title}`,
        primaryUrl: actionUrl,
        richContent: card,
      };
      console.log("[notify] report richContent:", JSON.stringify(card));
      if (dryRun) {
        dryMessages.push({ platformUserId: target.platformUserId, platformId: target.platformId, message });
      } else {
        await target.adapter.sendDirectMessage(target.platformUserId, message);
      }
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${target.platformUserId}: ${msg}`);
      console.error("[notify] report error for", target.platformUserId, e);
    }
  }

  return { sent, errors, ...(dryRun ? { dryMessages } : {}) };
}

// ─── Mention notifications ────────────────────────────────────────────────────

export async function dispatchMentionNotifications(
  reportId: string,
  eventId: string,
  productionId: string,
): Promise<void> {
  const mentionedUserIds = await listAllReportMentionedUserIds(reportId);
  if (!mentionedUserIds.length) return;

  const pool = getPool();
  const [rptRes, evRes, mentionOptedOut, targets] = await Promise.all([
    pool.query<{ title: string }>("SELECT title FROM event_report WHERE id = $1", [reportId]),
    pool.query<{ title: string }>("SELECT title FROM production_event WHERE id = $1", [eventId]),
    getOptedOutUsers("report_mention"),
    batchResolveNotificationTargets(mentionedUserIds, productionId),
  ]);
  const reportTitle = rptRes.rows[0]?.title ?? "报告";
  const eventTitle = evRes.rows[0]?.title ?? "";

  const reportBasePath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reports/${reportId}`;
  const tokenExp = new Date(Date.now() + 30 * 24 * 3_600_000);

  for (const userId of mentionedUserIds) {
    if (mentionOptedOut.has(userId)) continue;
    const target = targets.get(userId);
    if (!target) continue;
    try {
      const token = createCardToken(userId, `report:${reportId}`, tokenExp);
      const actionUrl = target.adapter.buildActionUrl(`${reportBasePath}/${token}`);
      const card = buildMentionCard(reportTitle, eventTitle, actionUrl);
      await target.adapter.sendDirectMessage(target.platformUserId, {
        text: `${eventTitle} 的报告「${reportTitle}」中提到了你，查看：${actionUrl}`,
        title: "报告提及",
        primaryUrl: actionUrl,
        richContent: card,
      });
    } catch (e) {
      console.error("[notify] mention notification error for", userId, e);
    }
  }
}

// ─── Re-export for legacy callers that resolve notification targets directly ──

export { resolveNotificationTarget } from "./platform/notification-router";
