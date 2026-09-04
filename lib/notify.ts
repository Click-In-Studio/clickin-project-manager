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
import { SERVER_URL } from "./server-url";
import {
  buildWeeklyCallCard, buildDailyCallCard, buildReportCard, buildMentionCard,
} from "./platform/feishu/feishu-bot";
import {
  listAllReportMentionedUserIds,
  type WeeklyCallEntry, type DailyCallScheduleItem,
} from "./event-db";
import { createCardToken } from "./card-token";
import { renderNotifyDoc } from "./notify-doc/from-markdown";
import { createNotifyRefResolver } from "./notify-doc/resolver";
import { toSummary } from "./notify-doc/platform-text";
import { toLarkMd } from "./notify-doc/platform-feishu";
import { toEmailHtml } from "./notify-doc/platform-html";
import { truncateDoc } from "./notify-doc/ast";
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

// ─── 用户正文 → 通道可用文本（通知管线的调用侧薄封装）────────────────────────
// 管线：markdown → 通知 variant renderer → 通用 AST → 平台 renderer。
// 站内信这一"通道"的能力是纯文本单行，所以用 toSummary；飞书卡片走
// notify-doc/platform-feishu，邮件走各自模板。共同点是**都不再碰 markdown 源码**。
async function projectInline(md: string | null | undefined, productionId: string): Promise<string> {
  if (!md?.trim()) return "";
  try {
    return toSummary(await renderNotifyDoc(md, createNotifyRefResolver(productionId)), 200);
  } catch {
    return md; // 投影失败不拖垮通知：宁可漏形态，不可少内容
  }
}

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
  approvalRequestId?: string | null;
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
// Task assignment notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 任务指派通知（2026-08-15 定谳：老板派活语义——纯告知，act=打开详情，
 * 不设接受/拒绝回执）。发送面 = 指派动作的四个写点（两条 PUT assignees 的
 * diff 新增、两条 POST 创建即指派）。指派人本人不收；正文带指派人名 attribution。
 */
export async function notifyTaskAssigned(params: {
  productionId: string;
  taskId: string;
  taskTitle: string;
  /** 绑定 event 时的语境标注（可空） */
  eventTitle?: string | null;
  /** 指派动作发起人（过滤自指派 + attribution） */
  assignedBy: string;
  userIds: string[];
}): Promise<void> {
  const recipients = [...new Set(params.userIds)].filter(id => id !== params.assignedBy);
  if (!recipients.length) return;

  const assignerRes = await getPool().query<{ name: string; display_name: string | null }>(
    `SELECT name, display_name FROM user_profile WHERE user_id = $1`,
    [params.assignedBy],
  ).catch(() => null);
  const assignerName = assignerRes?.rows[0]?.display_name || assignerRes?.rows[0]?.name || "";

  const taskTitle = params.taskTitle || "（未命名任务）";
  const context = params.eventTitle ? `（${params.eventTitle}）` : "";
  const reqPath = `${SERVER_URL}/production/${params.productionId}/tasks/${params.taskId}`;

  await notifyUsers({
    userIds: recipients,
    kind: "task_assign",
    productionId: params.productionId,
    entityType: "tech_req",
    entityId: params.taskId,
    title: `你被指派了任务：${taskTitle}`,
    body: [context, assignerName ? `指派人：${assignerName}` : ""].filter(Boolean).join(" "),
    viewHref: reqPath,
    category: "info",
    buildExternalMessage: async (_userId, target) => {
      const actionUrl = target.adapter.buildActionUrl(reqPath);
      return {
        text: `你被指派了任务：${taskTitle}${context}${assignerName ? `，指派人：${assignerName}` : ""}，查看：${actionUrl}`,
      };
    },
  });
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
    const viewHref = `${SERVER_URL}/production/${event.production_id}/events/${eventId}`;

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
          const rsvpBaseUrl = `${SERVER_URL}/api/rsvp?token=`;
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
    const viewHref = `${SERVER_URL}/my/weekly-call/${token}`;
    const userEnabled = !optedOut.has(userId);

    await notifyUser({
      userId,
      kind: "weekly_call",
      entityType: "weekly_call",
      entityId,
      title: `本周有 ${entries.length} 个安排`,
      body: (await Promise.all(entries.map(async (e) => {
        const time = new Date(e.callAt).toLocaleString("zh-CN", {
          month: "numeric", day: "numeric",
          hour: "2-digit", minute: "2-digit",
          timeZone: "Asia/Shanghai",
        });
        // 用户正文经通知管线投影：正文里的 [#](/__cm__/…) 引用会被解析成实时
        // 标签，方言排版拍平成一行。不投影就会把私有 href 原样漏进站内信。
        const parts = [e.eventTitle];
        const desc = await projectInline(e.eventDescription, e.productionId);
        if (desc) parts.push(desc);
        parts.push(`Call：${time}`);
        const notes = await projectInline(e.callNotes, e.productionId);
        if (notes) parts.push(`备注：${notes}`);
        return parts.join(" · ");
      }))).join("\n"),
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
       FROM task etr
       JOIN task_assignee eta ON eta.task_id = etr.id AND eta.user_id = $1
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
    const viewHref = `${SERVER_URL}/my/daily-call/${dateStr}/${token}`;
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
          const rsvpBaseUrl = `${SERVER_URL}/api/rsvp?token=`;
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
    `SELECT w.title, w.body, er.published_at
     FROM event_report er
     JOIN node nd ON nd.id = er.node_id
     JOIN wiki w ON w.id = nd.wiki_id
     WHERE er.id = $1`,
    [reportId],
  );
  const report = rptRes.rows[0];
  if (!report?.published_at) return { sent: 0, errors: [] };

  const [evRes, notesRes, rptProdNameRes] = await Promise.all([
    pool.query<{ title: string }>(`SELECT title FROM production_event WHERE id = $1`, [eventId]),
    pool.query<{ dept_name: string; content: string }>(
      `SELECT ed.name AS dept_name, w.body AS content
       FROM event_report_note ern
       JOIN production_dept ed ON ed.id = ern.department_id
       JOIN wiki w ON w.id = ern.wiki_id
       WHERE ern.report_id = $1 ORDER BY ed.display_order, ern.created_at`,
      [reportId],
    ),
    pool.query<{ name: string }>(`SELECT name FROM production WHERE id = $1`, [productionId]),
  ]);
  const eventTitle = evRes.rows[0]?.title ?? "";
  const rptProductionName = rptProdNameRes.rows[0]?.name ?? "后台";
  // 正文/备注是完整 wiki markdown（含四类方言与 id 引用）。**AST 只渲染一次**，
  // 各通道自己投影：飞书要 lark_md、邮件要 HTML。原先直接把裸 markdown 交给
  // 模板、模板再按字符数切——正好会把 [#](/__cm__/wiki/<uuid>) 拦腰截断，
  // 半截私有 href 漏进通知；截断现在在 AST 层做。
  const refResolver = createNotifyRefResolver(productionId);
  const reportDoc = await renderNotifyDoc(report.body ?? "", refResolver);
  const noteDocs = await Promise.all(notesRes.rows.map(async (r) => ({
    deptName: r.dept_name,
    doc: await renderNotifyDoc(r.content ?? "", refResolver),
  })));

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
  const viewHref = `${SERVER_URL}/production/${productionId}/reports/${reportId}`;
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
        const html = (d: Parameters<typeof toEmailHtml>[0], max: number) =>
          toEmailHtml(truncateDoc(d, max), { buildUrl: target.adapter.buildActionUrl, ink: "#182a2a", link: "#2f6670", muted: "#667676" });
        richContent = buildReportEmail({
          reportTitle: report.title, eventTitle, viewUrl: actionUrl,
          reportBodyHtml: html(reportDoc, 200),
          notes: noteDocs.map(n => ({ deptName: n.deptName, contentHtml: html(n.doc, 120) })),
        });
      } else {
        richContent = buildReportCard(
          report.title, eventTitle,
          toLarkMd(truncateDoc(reportDoc, 120), { buildUrl: target.adapter.buildActionUrl }),
          noteDocs.map(n => ({ deptName: n.deptName, content: toLarkMd(truncateDoc(n.doc, 100), { buildUrl: target.adapter.buildActionUrl }) })),
          report.published_at, actionUrl);
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
    pool.query<{ title: string }>(
      "SELECT w.title FROM event_report er JOIN node nd ON nd.id = er.node_id JOIN wiki w ON w.id = nd.wiki_id WHERE er.id = $1",
      [reportId],
    ),
    pool.query<{ title: string }>("SELECT title FROM production_event WHERE id = $1", [eventId]),
    pool.query<{ name: string }>("SELECT name FROM production WHERE id = $1", [productionId]),
  ]);
  const reportTitle = rptRes.rows[0]?.title ?? "报告";
  const eventTitle = evRes.rows[0]?.title ?? "";
  const mentionProductionName = mentionProdNameRes.rows[0]?.name ?? "后台";
  const viewHref = `${SERVER_URL}/production/${productionId}/reports/${reportId}`;
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

// ─────────────────────────────────────────────────────────────────────────────
// Announcement remind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send "催读" reminder to unread members for an announcement.
 * Each user gets an inbox entry + DM (if not opted out).
 */
export async function notifyAnnouncementRemind(params: {
  unreadUserIds: string[];
  announcementId: string;
  announcementTitle: string;
  productionId: string;
  productionName: string;
}): Promise<{ inboxCount: number; externalSent: number; errors: string[] }> {
  const { unreadUserIds, announcementId, announcementTitle, productionId, productionName } = params;
  if (!unreadUserIds.length) return { inboxCount: 0, externalSent: 0, errors: [] };

  const viewHref = `${SERVER_URL}/production/${productionId}/announcements`;

  return notifyUsers({
    userIds: unreadUserIds,
    kind: "announcement_remind",
    productionId,
    entityType: "announcement",
    entityId: announcementId,
    title: `${productionName} 有一条公告待阅读`,
    body: announcementTitle,
    viewHref,
    category: "info",
    buildExternalMessage: async (_userId, target) => {
      const actionUrl = target.adapter.buildActionUrl(viewHref);
      return {
        text: `【${productionName}】请查阅项目公告：「${announcementTitle}」\n点击查看：${actionUrl}`,
        title: "公告催读",
        primaryUrl: actionUrl,
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 成员退出（#141）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 退出必须是有声的——不存在「悄悄退出」。
 *
 * 收件人是 lib/member-exit-routing 的阶梯（直属上级链 → 制作人 → owner），
 * 不是只发给 owner：owner 往往不知道某个灯光助理是不是真的走了，知道的是灯光
 * 设计。但 action_required 只给持 member 门、真能推出口的人——给推不动的人挂
 * 一条待办，是让收件箱撒谎。
 */
export async function notifyMemberExitPending(params: {
  productionId: string;
  productionName: string;
  /** 退出的成员 */
  subjectUserId: string;
  subjectName: string;
  /** 自助退出 vs 人事停用 —— 文案与后续处置都不同 */
  source: "self" | "admin";
  handlers: { userId: string; canFinalize: boolean }[];
  note?: string | null;
}): Promise<void> {
  const recipients = params.handlers.filter((h) => h.userId !== params.subjectUserId);
  if (!recipients.length) return;

  const who = params.subjectName || "一名成员";
  const title =
    params.source === "self"
      ? `${who} 退出了《${params.productionName}》`
      : `${who} 在《${params.productionName}》被停用`;
  const href = `${SERVER_URL}/production/${params.productionId}/admin/organization`;

  const finalizers = recipients.filter((h) => h.canFinalize).map((h) => h.userId);
  const observers = recipients.filter((h) => !h.canFinalize).map((h) => h.userId);

  const body = [
    "其访问权已冻结，授权原样保留。",
    "待你处置：复职（原样恢复）或确认离组（撤销授权、保留历史）。",
    params.note ? `退出说明：${params.note}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const external = async (_userId: string, target: NotificationTarget) =>
    ({ text: `${title}。${body} 处理：${target.adapter.buildActionUrl(href)}` });

  if (finalizers.length) {
    await notifyUsers({
      userIds: finalizers,
      kind: "member_exit_pending",
      productionId: params.productionId,
      entityType: "production_member",
      entityId: params.subjectUserId,
      title,
      body,
      viewHref: href,
      category: "action",
      actionRequired: true,
      buildExternalMessage: external,
    });
  }

  // 推不动出口的上级：知情通知，可以表态（不认可 / 附议），但不挂待办。
  if (observers.length) {
    await notifyUsers({
      userIds: observers,
      kind: "member_exit_pending",
      productionId: params.productionId,
      entityType: "production_member",
      entityId: params.subjectUserId,
      title,
      body: "其访问权已冻结。你可以在成员页表态（不认可 / 附议），处置由持成员管理权限的人落地。",
      viewHref: href,
      category: "info",
      buildExternalMessage: external,
    });
  }
}

/** 通知当事人自己：被停用 / 被确认离组 / 被复职。 */
export async function notifyMemberStatusChanged(params: {
  productionId: string;
  productionName: string;
  userId: string;
  action: "suspend" | "restore" | "confirm_exit";
  note?: string | null;
}): Promise<void> {
  const title = {
    suspend: `你在《${params.productionName}》的成员资格已被停用`,
    restore: `你已恢复《${params.productionName}》的成员身份`,
    confirm_exit: `你已正式退出《${params.productionName}》`,
  }[params.action];

  const body = {
    suspend: "你暂时无法访问该项目内容。授权原样保留，复职后无需重新配置。",
    restore: "此前的授权已原样生效。",
    confirm_exit: "授权已撤销。你已完成的工作记录与署名不受影响。",
  }[params.action];

  await notifyUser({
    userId: params.userId,
    kind: "member_status_changed",
    productionId: params.productionId,
    entityType: "production_member",
    entityId: params.userId,
    title,
    body: [body, params.note ? `说明：${params.note}` : ""].filter(Boolean).join(" "),
    category: params.action === "restore" ? "info" : "warning",
    buildExternalMessage: async () => ({ text: `${title}。${body}` }),
  });
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { resolveNotificationTarget } from "./platform/notification-router";
export { isExternalEnabled };
