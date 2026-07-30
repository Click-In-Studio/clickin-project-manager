/**
 * Notification dispatch.
 *
 * Architecture — two primitives, everything goes through one of them:
 *
 *   notifyUser(userId, ...)
 *     Always writes inbox. If buildExternalMessage is provided, attempts
 *     external dispatch. Caller is responsible for preference gating
 *     (return null from buildExternalMessage to skip).
 *
 *   notifyUsers(userIds, ...)
 *     Batch inbox write (one INSERT for all recipients, same content).
 *     Handles preference gating internally, then dispatches external per user.
 *
 * Group-channel messages (e.g. Feishu dept group chat) are NOT routed through
 * these primitives — they don't produce individual inbox entries. Callers that
 * need both group + individual should send group messages directly and call
 * notifyUsers for the individual inbox/DM side.
 */

import { getPool } from "./pg";
import { BASE_PATH } from "./base-path";
import {
  buildWeeklyCallCard, buildDailyCallCard, buildReportCard, buildMentionCard,
} from "./platform/feishu/feishu-bot";
import {
  listAllReportMentionedUserIds,
  type WeeklyCallEntry, type DailyCallScheduleItem,
} from "./event-db";
import { createCardToken } from "./card-token";
import { signRsvpToken } from "./platform/email/email-tokens";
import {
  buildEventPublishEmail, buildWeeklyCallEmail, buildDailyCallEmail,
  buildReportEmail, buildMentionEmail,
} from "./platform/email/email-templates";
import {
  getOptedOutUsers, isExternalEnabled,
  shouldDeliverExternal, resolveDeliveryPolicy,
  type NotificationType,
} from "./notification-prefs";
import {
  createUserNotification, batchCreateUserNotifications,
  expireNotificationsByEntity,
  type NotificationAction,
  type NotificationCategory,
} from "./inbox-db";
import { resolveNotificationTarget, batchResolveNotificationTargets } from "./platform/notification-router";
import type { NotificationTarget } from "./platform/notification-router";
import type { PlatformMessage } from "./platform/types";

export type { NotificationTarget };

// ─── Result type ──────────────────────────────────────────────────────────────

export type DispatchResult = {
  sent: number;
  errors: string[];
  dryMessages?: { platformUserId: string; platformId: string; message: PlatformMessage }[];
};

// ─── Shared inbox content shape ───────────────────────────────────────────────

type InboxContent = {
  entityType: string;
  entityId: string;
  title: string;
  body?: string;
  viewHref?: string | null;
  /** Display tag: 'info' 普通通知 | 'action' 待确认 | 'warning' 警告. Defaults to 'info'. */
  category?: NotificationCategory;
  actionRequired?: boolean;
  actions?: NotificationAction[];
};

// ─────────────────────────────────────────────────────────────────────────────
// notifyUser — single-user primitive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write one inbox entry for a user and optionally dispatch to an external channel.
 *
 * Inbox write is UNCONDITIONAL — it always happens regardless of preferences.
 *
 * External dispatch: only if buildExternalMessage is provided. The function
 * receives the resolved platform target and returns the message to send, or
 * null to skip. Preference + policy gating is the CALLER'S responsibility —
 * if the user has opted out, return null from buildExternalMessage.
 */
export async function notifyUser(params: {
  userId: string;
  kind: NotificationType;
  productionId?: string | null;
} & InboxContent & {
  buildExternalMessage?: (target: NotificationTarget) => Promise<PlatformMessage | null>;
}): Promise<void> {
  const { userId, kind, productionId, buildExternalMessage, ...inbox } = params;

  // 1. Inbox — always.
  await createUserNotification({ userId, kind, productionId, ...inbox }).catch((e) => {
    console.error(`[notify] inbox write failed (user=${userId} kind=${kind}):`, e);
  });

  // 2. External — only if caller provides a message builder.
  if (!buildExternalMessage) return;
  try {
    const target = await resolveNotificationTarget(userId, productionId ?? undefined);
    if (!target) return;
    const message = await buildExternalMessage(target);
    if (!message) return;
    await target.adapter.sendDirectMessage(target.platformUserId, message);
  } catch (e) {
    console.error(`[notify] external dispatch failed (user=${userId} kind=${kind}):`, e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// notifyUsers — same-content batch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write inbox entries for a list of users (same content, batch INSERT) and
 * optionally dispatch to each user's external channel.
 *
 * External dispatch: preference + DeliveryPolicy gating is handled internally.
 * buildExternalMessage receives (userId, target) and returns the message, or
 * null to skip this user regardless of preferences.
 */
export async function notifyUsers(params: {
  userIds: string[];
  kind: NotificationType;
  productionId?: string | null;
} & InboxContent & {
  buildExternalMessage?: (
    userId: string,
    target: NotificationTarget,
  ) => Promise<PlatformMessage | null>;
}): Promise<{ inboxCount: number; externalSent: number; errors: string[] }> {
  const { userIds, kind, productionId, buildExternalMessage, ...inbox } = params;
  if (!userIds.length) return { inboxCount: 0, externalSent: 0, errors: [] };

  // 1. Inbox — batch write for all recipients.
  await batchCreateUserNotifications(userIds, { kind, productionId, ...inbox }).catch((e) => {
    console.error(`[notify] batch inbox write failed (kind=${kind}):`, e);
  });

  if (!buildExternalMessage) return { inboxCount: userIds.length, externalSent: 0, errors: [] };

  // 2. External — gated per user via preferences + DeliveryPolicy.
  const [targets, optedOut] = await Promise.all([
    batchResolveNotificationTargets(userIds, productionId ?? undefined),
    getOptedOutUsers(kind),
  ]);

  let externalSent = 0;
  const errors: string[] = [];

  for (const userId of userIds) {
    const target = targets.get(userId);
    if (!target) continue;
    const userEnabled = !optedOut.has(userId);
    const policy = await resolveDeliveryPolicy(productionId, kind, userId);
    if (!shouldDeliverExternal(userEnabled, "dm", policy)) continue;
    try {
      const message = await buildExternalMessage(userId, target);
      if (!message) continue;
      await target.adapter.sendDirectMessage(target.platformUserId, message);
      externalSent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${userId}: ${msg}`);
      console.error(`[notify] external dispatch failed (user=${userId} kind=${kind}):`, e);
    }
  }

  return { inboxCount: userIds.length, externalSent, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event publish notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send RSVP inbox notifications to all call_time recipients when an event is
 * published. Each recipient gets a notification with 是/否/待定 actions
 * (before the daily-call dispatch window) or just 确认 (after).
 *
 * Also expires any previous unacted event_publish notifications for the same
 * call_time rows (e.g. when an event is unpublished then re-published, or when
 * call times are modified).
 */
export async function dispatchEventPublishNotifications(eventId: string): Promise<void> {
  const pool = getPool();

  const [eventRes, callsRes] = await Promise.all([
    pool.query<{ title: string; description: string | null; production_id: string; start_time: string | null }>(
      `SELECT title, description, production_id, start_time FROM production_event WHERE id = $1`,
      [eventId],
    ),
    pool.query<{ id: string; user_id: string; call_at: string; name: string; notes: string | null }>(
      `SELECT id, user_id, call_at, name, notes FROM event_call_time WHERE event_id = $1 ORDER BY call_at`,
      [eventId],
    ),
  ]);

  const event = eventRes.rows[0];
  if (!event || !callsRes.rows.length) return;

  const prodNameRes = await pool.query<{ name: string }>(`SELECT name FROM production WHERE id = $1`, [event.production_id]);
  const productionName = prodNameRes.rows[0]?.name ?? "后台";

  // Determine whether we're inside the daily-call dispatch window:
  // after this window, RSVP degrades to hard confirm-only (同 daily-call 行为).
  const nowCst = new Date(Date.now() + 8 * 3_600_000);
  const isPastDispatchWindow = nowCst.getUTCHours() >= 12;

  const optedOut = await getOptedOutUsers("event_publish");
  const targets = await batchResolveNotificationTargets(
    callsRes.rows.map((r) => r.user_id),
    event.production_id,
  );

  const seen = new Set<string>();
  for (const row of callsRes.rows) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);

    // Expire any previous unacted RSVP notifications for this call_time.
    await expireNotificationsByEntity("call_time", row.id, row.user_id).catch(() => {});

    const callTimeStr = new Date(row.call_at).toLocaleTimeString("zh-CN", {
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
    });
    const viewHref = `${BASE_PATH}/production/${event.production_id}/events/${eventId}`;

    const rsvpActions: NotificationAction[] = isPastDispatchWindow
      ? [
          {
            id: "confirm",
            presentation: "primary_button",
            label: "确认出席",
            effects: [
              { type: "set_rsvp", entityType: "call_time", entityId: row.id, rsvp: "yes" },
              { type: "mark_acted" },
              { type: "mark_read" },
            ],
          },
        ]
      : [
          {
            id: "rsvp-yes",
            presentation: "primary_button",
            label: "是",
            effects: [
              { type: "set_rsvp", entityType: "call_time", entityId: row.id, rsvp: "yes" },
              { type: "mark_acted" },
              { type: "mark_read" },
            ],
          },
          {
            id: "rsvp-no",
            presentation: "secondary_button",
            label: "否",
            effects: [
              { type: "set_rsvp", entityType: "call_time", entityId: row.id, rsvp: "no" },
              { type: "mark_acted" },
              { type: "mark_read" },
            ],
          },
          {
            id: "rsvp-tentative",
            presentation: "secondary_button",
            label: "待定",
            effects: [
              { type: "set_rsvp", entityType: "call_time", entityId: row.id, rsvp: "tentative" },
              { type: "mark_acted" },
              { type: "mark_read" },
            ],
          },
        ];

    const userEnabled = !optedOut.has(row.user_id);
    const target = targets.get(row.user_id);

    await notifyUser({
      userId: row.user_id,
      kind: "event_publish",
      productionId: event.production_id,
      entityType: "call_time",
      entityId: row.id,
      title: `Event 已发布 — ${event.title}`,
      body: `你的 Call 时间：${callTimeStr}，请确认是否参加。`,
      viewHref,
      category: "action",
      actionRequired: true,
      actions: rsvpActions,
      buildExternalMessage: !target || !userEnabled ? undefined : async (resolvedTarget) => {
        const policy = await resolveDeliveryPolicy(event.production_id, "event_publish", row.user_id);
        if (!shouldDeliverExternal(userEnabled, "dm", policy)) return null;
        const actionUrl = resolvedTarget.adapter.buildActionUrl(viewHref);
        if (resolvedTarget.platformId === "email") {
          const confirmToken = signRsvpToken(row.user_id, row.id, "confirm");
          const rsvpUrls = isPastDispatchWindow ? undefined : {
            yes:      signRsvpToken(row.user_id, row.id, "yes"),
            no:       signRsvpToken(row.user_id, row.id, "no"),
            tentative: signRsvpToken(row.user_id, row.id, "tentative"),
          };
          const rsvpBaseUrl = `${BASE_PATH}/api/rsvp?token=`;
          return {
            text: `Event 已发布 — ${event.title}，你的 Call 时间：${callTimeStr}，查看：${actionUrl}`,
            title: `${productionName}通知`,
            primaryUrl: actionUrl,
            richContent: buildEventPublishEmail({
              eventTitle: event.title,
              eventDescription: event.description,
              callTimeStr,
              callTimeNotes: row.notes,
              viewUrl: actionUrl,
              rsvpUrls: rsvpUrls ? {
                yes:      `${rsvpBaseUrl}${encodeURIComponent(rsvpUrls.yes)}`,
                no:       `${rsvpBaseUrl}${encodeURIComponent(rsvpUrls.no)}`,
                tentative: `${rsvpBaseUrl}${encodeURIComponent(rsvpUrls.tentative)}`,
              } : undefined,
              confirmUrl: isPastDispatchWindow
                ? `${rsvpBaseUrl}${encodeURIComponent(confirmToken)}`
                : undefined,
            }),
          };
        }
        return {
          text: `Event 已发布 — ${event.title}，你的 Call 时间：${callTimeStr}，查看：${actionUrl}`,
          title: `Event 已发布 — ${event.title}`,
          primaryUrl: actionUrl,
        };
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly call
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchWeeklyCall(dryRun = false): Promise<DispatchResult> {
  const pool = getPool();

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() + 1);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);

  const usersRes = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM event_call_time WHERE call_at >= $1 AND call_at < $2`,
    [weekStart.toISOString(), weekEnd.toISOString()],
  );
  const userIds = usersRes.rows.map((r) => r.user_id);
  if (!userIds.length) return { sent: 0, errors: [] };

  const optedOut = await getOptedOutUsers("weekly_call");
  const weeklyTokenExp = new Date(Date.now() + 8 * 24 * 3_600_000);
  const entityId = weekStart.toISOString().slice(0, 10);

  let sent = 0;
  const errors: string[] = [];
  const dryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  for (const userId of userIds) {
    const entries = await getWeeklyCallDataForUser(userId, weekStart, weekEnd);
    if (!entries.length) continue;

    const token = createCardToken(userId, "weekly-call", weeklyTokenExp);
    const viewHref = `${BASE_PATH}/my/weekly-call/${token}`;
    const userEnabled = !optedOut.has(userId);

    await notifyUser({
      userId,
      kind: "weekly_call",
      entityType: "weekly_call",
      entityId,
      title: `本周有 ${entries.length} 个安排`,
      body: entries.map((e) => {
        const time = new Date(e.callAt).toLocaleString("zh-CN", {
          month: "numeric", day: "numeric",
          hour: "2-digit", minute: "2-digit",
          timeZone: "Asia/Shanghai",
        });
        const parts = [e.eventTitle];
        if (e.eventDescription) parts.push(e.eventDescription);
        parts.push(`Call：${time}`);
        if (e.callNotes) parts.push(`备注：${e.callNotes}`);
        return parts.join(" · ");
      }).join("\n"),
      viewHref,
      category: "info",
      buildExternalMessage: !userEnabled ? undefined : async (target) => {
        const policy = await resolveDeliveryPolicy(null, "weekly_call", userId);
        if (!shouldDeliverExternal(userEnabled, "dm", policy)) return null;
        const actionUrl = target.adapter.buildActionUrl(viewHref);
        let richContent: unknown;
        if (target.platformId === "email") {
          richContent = buildWeeklyCallEmail(entries, actionUrl);
        } else {
          richContent = buildWeeklyCallCard(entries, actionUrl);
        }
        const message: PlatformMessage = {
          text: `你本周有 ${entries.length} 场 Call，点击查看：${actionUrl}`,
          title: target.platformId === "email" ? "后台通知" : "本周 Call 安排",
          primaryUrl: actionUrl,
          richContent,
        };
        if (dryRun) {
          dryMessages.push({ platformUserId: target.platformUserId, platformId: target.platformId, message });
          return null;
        }
        return message;
      },
    });

    if (userEnabled) sent++;
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
    event_id: string; event_title: string; event_description: string; event_location: string; production_id: string;
  }>(
    `SELECT ect.call_at, ect.notes AS call_notes,
            pe.id AS event_id, pe.title AS event_title,
            pe.description AS event_description,
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
    eventDescription: r.event_description,
    eventLocation: r.event_location,
    productionId: r.production_id,
    scheduleItems: schedByEvent.get(r.event_id) ?? [],
    myTechReqs: reqsByEvent.get(r.event_id) ?? [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily call
// ─────────────────────────────────────────────────────────────────────────────

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
     WHERE pe.status = 'published' AND ect.call_at >= $1 AND ect.call_at < $2`,
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
    title: string; location: string; start_time: string | null; production_id: string;
  }>(
    `SELECT title, location, start_time, production_id FROM production_event WHERE id = $1`,
    [eventId],
  );
  const event = eventRes.rows[0];
  if (!event || !event.start_time) return { sent: 0, errors: [] };

  const dailyProdNameRes = await pool.query<{ name: string }>(`SELECT name FROM production WHERE id = $1`, [event.production_id]);
  const dailyProductionName = dailyProdNameRes.rows[0]?.name ?? "后台";

  const callsRes = await pool.query<{
    id: string; user_id: string; name: string; call_at: string; notes: string;
  }>(
    `SELECT id, user_id, name, call_at, notes FROM event_call_time WHERE event_id = $1 ORDER BY call_at`,
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

  const optedOut = await getOptedOutUsers("daily_call");

  let sent = 0;
  const errors: string[] = [];
  const dryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  const seen = new Set<string>();
  for (const row of callsRes.rows) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);

    const token = createCardToken(row.user_id, "daily-call", dailyTokenExp);
    const viewHref = `${BASE_PATH}/my/daily-call/${dateStr}/${token}`;
    const userEnabled = !optedOut.has(row.user_id);

    const confirmAction: NotificationAction = {
      id: "confirm",
      presentation: "primary_button",
      label: "确认出席",
      effects: [
        { type: "set_field", entityType: "call_time", entityId: row.id, field: "confirmed_at" },
        { type: "mark_acted" },
        { type: "mark_read" },
      ],
    };

    await notifyUser({
      userId: row.user_id,
      kind: "daily_call",
      productionId: event.production_id,
      entityType: "event",
      entityId: eventId,
      title: `明日 Call — ${event.title}`,
      body: `你的 Call 时间：${new Date(row.call_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}`,
      viewHref,
      category: "action",
      actionRequired: true,
      actions: [confirmAction],
      buildExternalMessage: !userEnabled ? undefined : async (target) => {
        const policy = await resolveDeliveryPolicy(event.production_id, "daily_call", row.user_id);
        if (!shouldDeliverExternal(userEnabled, "dm", policy)) return null;
        const actionUrl = target.adapter.buildActionUrl(viewHref);
        let richContent: unknown;
        if (target.platformId === "email") {
          const confirmToken = signRsvpToken(row.user_id, row.id, "confirm");
          const rsvpBaseUrl = `${BASE_PATH}/api/rsvp?token=`;
          richContent = buildDailyCallEmail({
            eventTitle: event.title,
            eventLocation: event.location,
            startTime: event.start_time!,
            myCallAt: row.call_at,
            myCallNotes: row.notes,
            scheduleItems,
            allCalls,
            viewUrl: actionUrl,
            confirmUrl: `${rsvpBaseUrl}${encodeURIComponent(confirmToken)}`,
          });
        } else {
          richContent = buildDailyCallCard(
            event.title, event.location, event.start_time!,
            row.call_at, row.notes, scheduleItems, allCalls, actionUrl,
          );
        }
        const message: PlatformMessage = {
          text: `明日 Call — ${event.title}，你的 Call 时间：${row.call_at}，查看：${actionUrl}`,
          title: target.platformId === "email" ? `${dailyProductionName}通知` : `明日 Call Sheet — ${event.title}`,
          primaryUrl: actionUrl,
          richContent,
        };
        if (dryRun) {
          dryMessages.push({ platformUserId: target.platformUserId, platformId: target.platformId, message });
          return null;
        }
        return message;
      },
    });

    if (userEnabled) sent++;
  }

  return { sent, errors, ...(dryRun ? { dryMessages } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

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
  if (!report?.published_at) return { sent: 0, errors: [] };

  const [evRes, notesRes, rptProdNameRes] = await Promise.all([
    pool.query<{ title: string }>(`SELECT title FROM production_event WHERE id = $1`, [eventId]),
    pool.query<{ dept_name: string; content: string }>(
      `SELECT ed.name AS dept_name, ern.content
       FROM event_report_note ern
       JOIN event_department ed ON ed.id = ern.department_id
       WHERE ern.report_id = $1 ORDER BY ed.display_order, ern.created_at`,
      [reportId],
    ),
    pool.query<{ name: string }>(`SELECT name FROM production WHERE id = $1`, [productionId]),
  ]);
  const eventTitle = evRes.rows[0]?.title ?? "";
  const rptProductionName = rptProdNameRes.rows[0]?.name ?? "后台";
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
  const viewHref = `${BASE_PATH}/production/${productionId}/reports/${reportId}`;
  const reportTokenExp = new Date(Date.now() + 30 * 24 * 3_600_000);

  const dryMessages: { platformUserId: string; platformId: string; message: PlatformMessage }[] = [];

  const result = await notifyUsers({
    userIds,
    kind: "report_broadcast",
    productionId,
    entityType: "report",
    entityId: reportId,
    title: `新报告：${report.title}`,
    body: eventTitle,
    viewHref,
    category: "info",
    buildExternalMessage: async (userId, target) => {
      const token = createCardToken(userId, `report:${reportId}`, reportTokenExp);
      const actionUrl = target.adapter.buildActionUrl(`${viewHref}/${token}`);
      let richContent: unknown;
      if (target.platformId === "email") {
        richContent = buildReportEmail({ reportTitle: report.title, eventTitle, reportBody: report.body, notes, viewUrl: actionUrl });
      } else {
        richContent = buildReportCard(report.title, eventTitle, report.body, notes, report.published_at, actionUrl);
      }
      const message: PlatformMessage = {
        text: `新报告：${report.title}（${eventTitle}），查看：${actionUrl}`,
        title: target.platformId === "email" ? `${rptProductionName}通知` : `新报告 — ${report.title}`,
        primaryUrl: actionUrl,
        richContent,
      };
      if (dryRun) {
        dryMessages.push({ platformUserId: target.platformUserId, platformId: target.platformId, message });
        return null;
      }
      return message;
    },
  });

  return {
    sent: result.externalSent,
    errors: result.errors,
    ...(dryRun ? { dryMessages } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mention notifications
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchMentionNotifications(
  reportId: string,
  eventId: string,
  productionId: string,
): Promise<void> {
  const mentionedUserIds = await listAllReportMentionedUserIds(reportId);
  if (!mentionedUserIds.length) return;

  const pool = getPool();
  const [rptRes, evRes, mentionProdNameRes] = await Promise.all([
    pool.query<{ title: string }>("SELECT title FROM event_report WHERE id = $1", [reportId]),
    pool.query<{ title: string }>("SELECT title FROM production_event WHERE id = $1", [eventId]),
    pool.query<{ name: string }>("SELECT name FROM production WHERE id = $1", [productionId]),
  ]);
  const reportTitle = rptRes.rows[0]?.title ?? "报告";
  const eventTitle = evRes.rows[0]?.title ?? "";
  const mentionProductionName = mentionProdNameRes.rows[0]?.name ?? "后台";
  const viewHref = `${BASE_PATH}/production/${productionId}/reports/${reportId}`;
  const tokenExp = new Date(Date.now() + 30 * 24 * 3_600_000);

  await notifyUsers({
    userIds: mentionedUserIds,
    kind: "report_mention",
    productionId,
    entityType: "report",
    entityId: reportId,
    title: `${eventTitle} 的报告中提到了你`,
    body: reportTitle,
    viewHref,
    category: "info",
    buildExternalMessage: async (userId, target) => {
      const token = createCardToken(userId, `report:${reportId}`, tokenExp);
      const actionUrl = target.adapter.buildActionUrl(`${viewHref}/${token}`);
      const richContent = target.platformId === "email"
        ? buildMentionEmail({ reportTitle, eventTitle, viewUrl: actionUrl })
        : buildMentionCard(reportTitle, eventTitle, actionUrl);
      return {
        text: `${eventTitle} 的报告「${reportTitle}」中提到了你，查看：${actionUrl}`,
        title: target.platformId === "email" ? `${mentionProductionName}通知` : "报告提及",
        primaryUrl: actionUrl,
        richContent,
      };
    },
  });
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { resolveNotificationTarget } from "./platform/notification-router";
export { isExternalEnabled };
