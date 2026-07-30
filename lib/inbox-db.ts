/**
 * Personal notification inbox — DB layer.
 *
 * The inbox is always-on: every notifyUsers() call writes here regardless of
 * the recipient's external-channel preferences. External dispatch (Feishu etc.)
 * is a separate, configurable side-effect handled in notify.ts.
 */

import { getPool } from "./pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationAction = {
  /** Stable identifier within this notification's actions array. */
  id: string;
  /** UI presentation hint. */
  presentation: "primary_button" | "secondary_button";
  label: string;
  /**
   * What happens when the user triggers this action.
   * The act endpoint executes these in a single transaction.
   */
  effects: ActionEffect[];
};

export type ActionEffect =
  | { type: "set_field";   entityType: string; entityId: string; field: string }
  | { type: "set_status";  entityType: string; entityId: string; to: string }
  | { type: "set_choice";  entityType: string; entityId: string }
  /** Soft RSVP for a call time row before the daily-call dispatch window. */
  | { type: "set_rsvp";    entityType: "call_time"; entityId: string; rsvp: "yes" | "no" | "tentative" }
  | { type: "mark_read"; entityType?: string; entityId?: string }
  | { type: "mark_acted" };

export type NotificationCategory = "info" | "action" | "warning";

export type UserNotification = {
  id: string;
  userId: string;
  productionId: string | null;
  kind: string;
  entityType: string;
  entityId: string;
  title: string;
  body: string;
  /** Optional direct link rendered as "查看详情". Independent of actions. */
  viewHref: string | null;
  /** Display tag: 'info' 普通通知 | 'action' 待确认 | 'warning' 警告 */
  category: NotificationCategory;
  createdAt: string;
  readAt: string | null;
  actionRequired: boolean;
  actions: NotificationAction[];
  actedAt: string | null;
  actionResult: unknown | null;
  /**
   * Set when a superseding notification was sent for the same entity
   * (e.g. call time modified after dispatch). Expired notifications render
   * their action buttons as disabled — the new notification supersedes them.
   */
  expiredAt: string | null;
};

type NotifRow = {
  id: string;
  user_id: string;
  production_id: string | null;
  kind: string;
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  view_href: string | null;
  category: string;
  created_at: Date;
  read_at: Date | null;
  action_required: boolean;
  actions: NotificationAction[];
  acted_at: Date | null;
  action_result: unknown | null;
  expired_at: Date | null;
};

function rowToNotif(r: NotifRow): UserNotification {
  return {
    id: r.id,
    userId: r.user_id,
    productionId: r.production_id,
    kind: r.kind,
    entityType: r.entity_type,
    entityId: r.entity_id,
    title: r.title,
    body: r.body,
    viewHref: r.view_href,
    category: (r.category as NotificationCategory) ?? "info",
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at ? r.read_at.toISOString() : null,
    actionRequired: r.action_required,
    actions: r.actions ?? [],
    actedAt: r.acted_at ? r.acted_at.toISOString() : null,
    actionResult: r.action_result ?? null,
    expiredAt: r.expired_at ? r.expired_at.toISOString() : null,
  };
}

// ─── ID generation ────────────────────────────────────────────────────────────

let _seq = 0;
function makeId() {
  return `un${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export type CreateNotificationParams = {
  userId: string;
  productionId?: string | null;
  kind: string;
  entityType: string;
  entityId: string;
  title: string;
  body?: string;
  viewHref?: string | null;
  category?: NotificationCategory;
  actionRequired?: boolean;
  actions?: NotificationAction[];
};

/** Insert a single inbox entry. */
export async function createUserNotification(
  params: CreateNotificationParams,
): Promise<UserNotification> {
  const id = makeId();
  const res = await getPool().query<NotifRow>(
    `INSERT INTO user_notification
       (id, user_id, production_id, kind, entity_type, entity_id,
        title, body, view_href, category, action_required, actions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      id,
      params.userId,
      params.productionId ?? null,
      params.kind,
      params.entityType,
      params.entityId,
      params.title,
      params.body ?? "",
      params.viewHref ?? null,
      params.category ?? "info",
      params.actionRequired ?? false,
      JSON.stringify(params.actions ?? []),
    ],
  );
  return rowToNotif(res.rows[0]);
}

/**
 * Insert inbox entries for multiple users at once (same content, different recipients).
 * Runs as a single multi-row INSERT for efficiency.
 */
export async function batchCreateUserNotifications(
  userIds: string[],
  shared: Omit<CreateNotificationParams, "userId">,
): Promise<void> {
  if (!userIds.length) return;

  const rows = userIds.map((userId) => ({
    id: makeId(),
    userId,
    productionId: shared.productionId ?? null,
    kind: shared.kind,
    entityType: shared.entityType,
    entityId: shared.entityId,
    title: shared.title,
    body: shared.body ?? "",
    viewHref: shared.viewHref ?? null,
    category: shared.category ?? "info",
    actionRequired: shared.actionRequired ?? false,
    actions: JSON.stringify(shared.actions ?? []),
  }));

  const cols = 12;
  const valueClauses = rows.map(
    (_, i) =>
      `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},$${i * cols + 6},$${i * cols + 7},$${i * cols + 8},$${i * cols + 9},$${i * cols + 10},$${i * cols + 11},$${i * cols + 12})`,
  );
  const values = rows.flatMap((r) => [
    r.id, r.userId, r.productionId, r.kind, r.entityType, r.entityId,
    r.title, r.body, r.viewHref, r.category, r.actionRequired, r.actions,
  ]);

  await getPool().query(
    `INSERT INTO user_notification
       (id, user_id, production_id, kind, entity_type, entity_id,
        title, body, view_href, category, action_required, actions)
     VALUES ${valueClauses.join(",")}`,
    values,
  );
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function countUnreadNotifications(userId: string, productionId?: string): Promise<number> {
  const params: unknown[] = [userId];
  const prodFilter = productionId ? `AND production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_notification
     WHERE user_id = $1
       AND acted_at IS NULL
       AND (action_required = true OR read_at IS NULL)
       ${prodFilter}`,
    params,
  );
  return parseInt(res.rows[0].count, 10);
}

export type ListNotificationsOptions = {
  productionId?: string;
  /** "all" | "pending" (action_required + not acted) | "read" */
  filter?: "all" | "pending" | "read";
  limit?: number;
  before?: string; // ISO timestamp cursor for pagination
};

export async function listUserNotifications(
  userId: string,
  opts: ListNotificationsOptions = {},
): Promise<UserNotification[]> {
  const { productionId, filter = "all", limit = 40, before } = opts;
  const conditions: string[] = ["user_id = $1"];
  const params: unknown[] = [userId];

  if (productionId) {
    conditions.push(`production_id = $${params.push(productionId)}`);
  }
  if (filter === "pending") {
    conditions.push("action_required = true AND acted_at IS NULL");
  } else if (filter === "read") {
    conditions.push("read_at IS NOT NULL");
  }
  if (before) {
    conditions.push(`created_at < $${params.push(before)}`);
  }

  const res = await getPool().query<NotifRow>(
    `SELECT * FROM user_notification
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.push(limit)}`,
    params,
  );
  return res.rows.map(rowToNotif);
}

export async function getUserNotification(
  id: string,
  userId: string,
): Promise<UserNotification | null> {
  const res = await getPool().query<NotifRow>(
    `SELECT * FROM user_notification WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return res.rows[0] ? rowToNotif(res.rows[0]) : null;
}

// ─── State transitions ────────────────────────────────────────────────────────

export async function markNotificationRead(
  id: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE user_notification
     SET read_at = now()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [id, userId],
  );
}

export async function markAllNotificationsRead(
  userId: string,
  productionId?: string,
): Promise<void> {
  const params: unknown[] = [userId];
  const extra = productionId
    ? `AND production_id = $${params.push(productionId)}`
    : "";
  await getPool().query(
    `UPDATE user_notification
     SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL ${extra}`,
    params,
  );
}

export async function markNotificationActed(
  id: string,
  userId: string,
  actionId: string,
  value?: unknown,
): Promise<void> {
  await getPool().query(
    `UPDATE user_notification
     SET acted_at = now(),
         action_result = $3,
         read_at = COALESCE(read_at, now())
     WHERE id = $1 AND user_id = $2`,
    [id, userId, JSON.stringify({ action_id: actionId, value: value ?? null })],
  );
}

/**
 * Clear confirmed_at on all call times for an event (used when a call is modified
 * after dispatch, requiring re-confirmation from all recipients).
 */
export async function invalidateCallTimeConfirmations(
  eventId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE event_call_time SET confirmed_at = NULL WHERE event_id = $1`,
    [eventId],
  );
}

export async function confirmCallTime(
  callTimeId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE event_call_time
     SET confirmed_at = now()
     WHERE id = $1 AND user_id = $2`,
    [callTimeId, userId],
  );
}

/**
 * Auto-complete action_required notifications whose underlying entity has been deleted.
 * Called on every notification list fetch so the inbox stays clean without a background job.
 *
 * Covered entity types:
 *   tech_req  — event_tech_req (CASCADE-deleted when production_event is deleted)
 *   call_time — event_call_time (CASCADE-deleted when production_event is deleted)
 */
export async function autoCompleteDeadNotifications(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE user_notification
     SET acted_at   = now(),
         read_at    = COALESCE(read_at, now()),
         action_result = '{"auto_expired":"entity_deleted"}'
     WHERE user_id        = $1
       AND action_required = true
       AND acted_at        IS NULL
       AND (
         (entity_type = 'tech_req'  AND NOT EXISTS (SELECT 1 FROM event_tech_req  WHERE id = user_notification.entity_id))
         OR
         (entity_type = 'call_time' AND NOT EXISTS (SELECT 1 FROM event_call_time WHERE id = user_notification.entity_id))
       )`,
    [userId],
  );
}

/**
 * Expire all unacted notifications for a given entity (and optionally a specific user).
 *
 * Call this when a superseding event occurs — e.g. a call time is modified after
 * the original notification was sent. The old notifications will have their action
 * buttons disabled in the UI; the caller should then create a new notification.
 */
export async function expireNotificationsByEntity(
  entityType: string,
  entityId: string,
  userId?: string,
): Promise<void> {
  const params: unknown[] = [entityType, entityId];
  const userClause = userId ? `AND user_id = $${params.push(userId)}` : "";
  await getPool().query(
    `UPDATE user_notification
     SET expired_at = now()
     WHERE entity_type = $1
       AND entity_id = $2
       AND expired_at IS NULL
       AND acted_at IS NULL
       ${userClause}`,
    params,
  );
}

/**
 * Record a soft RSVP (是/否/待定) on a call time row.
 * Returns the updated call time's event_id so the caller can notify the event owner.
 */
export async function rsvpCallTime(
  callTimeId: string,
  userId: string,
  rsvp: "yes" | "no" | "tentative",
): Promise<{ eventId: string } | null> {
  const res = await getPool().query<{ event_id: string }>(
    `UPDATE event_call_time
     SET rsvp = $1, rsvp_at = now()
     WHERE id = $2 AND user_id = $3
     RETURNING event_id`,
    [rsvp, callTimeId, userId],
  );
  return res.rows[0] ? { eventId: res.rows[0].event_id } : null;
}
