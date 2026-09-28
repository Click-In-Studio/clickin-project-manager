import { getPool } from "@/lib/pg";
import { enqueueJob, TerminalJobError } from "@/lib/job/queue";
import { SERVER_URL } from "@/lib/server-url";
import { signRsvpToken } from "@/lib/platform/email/email-tokens";
import { buildNotificationEmail } from "@/lib/platform/email/email-templates";
import { buildEventChangeCard } from "@/lib/platform/feishu/feishu-bot";
import { batchResolveNotificationTargets } from "@/lib/platform/notification-router";
import {
  getOptedOutUsers, resolveDeliveryPolicy, shouldDeliverExternal,
} from "./notification-prefs";
import {
  expireNotificationsByEntity, invalidateCallTimeConfirmations,
  type NotificationAction,
} from "./inbox-db";
import { notifyUser } from "./notify";

const MERGE_WINDOW_MS = 5 * 60_000;

export type EventChangeBaseline = {
  status: "published";
  startTime: string | null;
  endTime: string | null;
  location: string;
};

type EventChangePayload = {
  eventId: string;
  before: EventChangeBaseline;
};

type CurrentEvent = {
  title: string;
  production_id: string;
  status: string;
  start_time: string | null;
  end_time: string | null;
  location: string;
};

export async function scheduleEventChangeNotification(
  eventId: string,
  before: EventChangeBaseline,
): Promise<void> {
  await enqueueJob({
    kind: "event_change_notify",
    payload: { eventId, before },
    dedupeKey: `event_change_notify:${eventId}`,
    runAfter: new Date(Date.now() + MERGE_WINDOW_MS),
  });
}

function validPayload(payload: Record<string, unknown>): EventChangePayload | null {
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  const raw = payload.before;
  if (!eventId || !raw || typeof raw !== "object") return null;
  const before = raw as Record<string, unknown>;
  if (before.status !== "published") return null;
  if (before.startTime !== null && typeof before.startTime !== "string") return null;
  if (before.endTime !== null && typeof before.endTime !== "string") return null;
  if (typeof before.location !== "string") return null;
  return {
    eventId,
    before: {
      status: "published",
      startTime: before.startTime as string | null,
      endTime: before.endTime as string | null,
      location: before.location,
    },
  };
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

function fmtTime(value: string | null): string {
  if (!value) return "未设置";
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", hour12: false,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function changeLines(before: EventChangeBaseline, event: CurrentEvent): string[] {
  const lines: string[] = [];
  if (!sameInstant(before.startTime, event.start_time)) {
    lines.push(`开始时间：${fmtTime(before.startTime)} → ${fmtTime(event.start_time)}`);
  }
  if (!sameInstant(before.endTime, event.end_time)) {
    lines.push(`结束时间：${fmtTime(before.endTime)} → ${fmtTime(event.end_time)}`);
  }
  if (before.location !== event.location) {
    lines.push(`地点：${before.location || "未设置"} → ${event.location || "未设置"}`);
  }
  return lines;
}

export async function dispatchEventChangeNotification(
  rawPayload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = validPayload(rawPayload);
  if (!payload) throw new TerminalJobError("event_change_notify payload 无效");

  const pool = getPool();
  const eventRes = await pool.query<CurrentEvent>(
    `SELECT title, production_id, status, start_time, end_time, location
     FROM production_event WHERE id = $1`,
    [payload.eventId],
  );
  const event = eventRes.rows[0];
  if (!event || event.status === "draft" || event.status === "completed") {
    return { skipped: event ? event.status : "deleted" };
  }

  const cancelled = event.status === "cancelled";
  const changes = changeLines(payload.before, event);
  if (!cancelled && (event.status !== "published" || changes.length === 0)) {
    return { skipped: "no_net_change" };
  }

  const recipients = await pool.query<{ user_id: string; call_time_id: string | null }>(
    `SELECT r.user_id, MIN(ect.id) AS call_time_id
     FROM (
       SELECT user_id FROM event_participant WHERE event_id = $1
       UNION
       SELECT user_id FROM event_call_time WHERE event_id = $1
     ) r
     LEFT JOIN event_call_time ect ON ect.event_id = $1 AND ect.user_id = r.user_id
     GROUP BY r.user_id`,
    [payload.eventId],
  );
  if (!recipients.rows.length) return { sent: 0 };

  const callRows = recipients.rows.filter((row) => row.call_time_id);
  if (cancelled) {
    await Promise.all(callRows.map((row) =>
      expireNotificationsByEntity("call_time", row.call_time_id!, row.user_id).catch(() => {}),
    ));
  } else {
    await invalidateCallTimeConfirmations(payload.eventId);
    await Promise.all(callRows.map((row) =>
      expireNotificationsByEntity("call_time", row.call_time_id!, row.user_id).catch(() => {}),
    ));
  }

  const userIds = recipients.rows.map((row) => row.user_id);
  const [targets, optedOut] = await Promise.all([
    batchResolveNotificationTargets(userIds, event.production_id),
    getOptedOutUsers("event_publish"),
  ]);
  const viewHref = `${SERVER_URL}/production/${event.production_id}/events/${payload.eventId}`;
  const body = cancelled ? "这项活动已取消，请不要再按原安排前往。" : changes.join("\n");
  const title = cancelled ? `活动已取消 — ${event.title}` : `活动安排有变 — ${event.title}`;

  for (const row of recipients.rows) {
    const needsConfirm = !cancelled && row.call_time_id !== null;
    const actions: NotificationAction[] = needsConfirm ? [{
      id: "confirm",
      presentation: "primary_button",
      label: "确认新安排",
      effects: [
        { type: "set_field", entityType: "call_time", entityId: row.call_time_id!, field: "confirmed_at" },
        { type: "mark_acted" },
        { type: "mark_read" },
      ],
    }] : [];
    const target = targets.get(row.user_id);
    const userEnabled = !optedOut.has(row.user_id);

    await notifyUser({
      userId: row.user_id,
      kind: "event_publish",
      productionId: event.production_id,
      entityType: needsConfirm ? "call_time" : "event",
      entityId: needsConfirm ? row.call_time_id! : payload.eventId,
      title,
      body,
      viewHref,
      category: cancelled ? "warning" : needsConfirm ? "action" : "info",
      actionRequired: needsConfirm,
      actions,
      buildExternalMessage: !target || !userEnabled ? undefined : async (resolvedTarget) => {
        const policy = await resolveDeliveryPolicy(event.production_id, "event_publish", row.user_id);
        if (!shouldDeliverExternal(userEnabled, "dm", policy)) return null;
        const eventUrl = resolvedTarget.adapter.buildActionUrl(viewHref);
        const confirmUrl = needsConfirm
          ? `${SERVER_URL}/api/rsvp?token=${encodeURIComponent(signRsvpToken(row.user_id, row.call_time_id!, "confirm"))}`
          : null;
        const actionUrl = confirmUrl ?? eventUrl;
        const text = `${title}\n${body}${needsConfirm ? "\n请确认新安排：" : "\n查看："}${actionUrl}`;
        return {
          text,
          title,
          primaryUrl: actionUrl,
          richContent: resolvedTarget.platformId === "email"
            ? buildNotificationEmail({
                title: escapeHtml(title),
                body: escapeHtml(body.replaceAll("\n", "；")),
                ctaLabel: needsConfirm ? "确认新安排" : "查看活动",
                ctaUrl: actionUrl,
              })
            : resolvedTarget.platformId === "feishu"
              ? buildEventChangeCard(title, body, actionUrl, needsConfirm)
              : undefined,
        };
      },
    });
  }

  return { sent: recipients.rows.length, cancelled, changes: changes.length };
}
