import { getPool } from "./pg";

// ─── Notification type registry ───────────────────────────────────────────────
//
// externalChannel:
//   'dm'    → personal DM to the user (default on, user can opt out)
//   'group' → group chat @mention (default off, user can opt in for a DM copy)
//   null    → inbox-only, no external dispatch
//
// defaultExternalEnabled: controls the external channel; inbox is always on.

export const NOTIFICATION_CONFIG = {
  // ── Scheduled dispatches ──────────────────────────────────────────────────
  daily_call: {
    label: "日 Call 提醒",
    description: "演出前一天发送，含你的 call 时间和当天日程",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  weekly_call: {
    label: "周 Call 汇总",
    description: "每周日发送，含本周所有演出和待处理技术需求",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Event ─────────────────────────────────────────────────────────────────
  event_publish: {
    label: "活动发布通知",
    description: "你参与或关注的活动发布或状态变更时通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Call confirmation ─────────────────────────────────────────────────────
  // Sent immediately when a call time is dispatched (either cron or on-demand).
  // action_required = true; confirms event_call_time.confirmed_at.
  call_time: {
    label: "Call Time 确认",
    description: "你的 call 时间确定或变更时需要确认",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Reports ───────────────────────────────────────────────────────────────
  report_broadcast: {
    label: "报告发布通知",
    description: "报告发布时推送给所有关注者和参与者",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  report_mention: {
    label: "报告 @ 提及",
    description: "报告或部门备注中被 @ 时收到通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Mentions ──────────────────────────────────────────────────────────────
  comment_mention: {
    label: "评论 @ 提及",
    description: "剧本或 cue 评论中被 @ 时收到通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Cue ───────────────────────────────────────────────────────────────────
  cue_warning: {
    label: "Cue 报警通知",
    description: "你负责的 Cue 表中有 Cue 被标记为报警时通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Tech reqs ─────────────────────────────────────────────────────────────
  // POC path: complex multi-item flow, navigate to details page to handle.
  tech_req_poc: {
    label: "技术需求待处理（POC）",
    description: "作为 POC 时，部门有待确认的技术需求",
    externalChannel: "group" as const,
    defaultExternalEnabled: false,
  },
  // Assignee path: individual assignment, simple confirm or view.
  task_assign: {
    label: "任务指派通知",
    description: "技术需求被指派给你时通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  announcement_remind: {
    label: "公告催读",
    description: "有你尚未阅读的项目公告时收到提醒",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  member_invite: {
    label: "项目邀请",
    description: "被邀请加入某个项目时通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  // ── Approval requests ─────────────────────────────────────────────────────
  approval_request_pending: {
    label: "资源申请待审批",
    description: "有成员申请资源访问权限需要你审批时通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
  approval_request_result: {
    label: "资源申请结果通知",
    description: "你提交的资源访问申请有结果时通知",
    externalChannel: "dm" as const,
    defaultExternalEnabled: true,
  },
} as const;

export type NotificationType = keyof typeof NOTIFICATION_CONFIG;
export const ALL_NOTIFICATION_TYPES = Object.keys(NOTIFICATION_CONFIG) as NotificationType[];

export type NotifPref = {
  type: NotificationType;
  label: string;
  description: string;
  externalChannel: "dm" | "group" | null;
  defaultExternalEnabled: boolean;
  externalEnabled: boolean;
};

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** All prefs for one user, with defaults filled in for unset types. */
export async function getUserPrefs(userId: string): Promise<NotifPref[]> {
  const res = await getPool().query<{ notification_type: string; enabled: boolean }>(
    `SELECT notification_type, enabled FROM notification_subscription WHERE user_id = $1`,
    [userId],
  );
  const stored = new Map(res.rows.map((r) => [r.notification_type, r.enabled]));
  return ALL_NOTIFICATION_TYPES.map((type) => {
    const cfg = NOTIFICATION_CONFIG[type];
    const defaultExternalEnabled = cfg.defaultExternalEnabled;
    return {
      type,
      label: cfg.label,
      description: cfg.description,
      externalChannel: cfg.externalChannel,
      defaultExternalEnabled,
      externalEnabled: stored.has(type) ? stored.get(type)! : defaultExternalEnabled,
    };
  });
}

/** Set one pref. When value matches the default, the row is deleted (keep the table sparse). */
export async function setUserPref(
  userId: string,
  type: NotificationType,
  enabled: boolean,
): Promise<void> {
  if (enabled === NOTIFICATION_CONFIG[type].defaultExternalEnabled) {
    await getPool().query(
      `DELETE FROM notification_subscription WHERE user_id = $1 AND notification_type = $2`,
      [userId, type],
    );
  } else {
    await getPool().query(
      `INSERT INTO notification_subscription (user_id, notification_type, enabled, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, notification_type)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [userId, type, enabled],
    );
  }
}

/** Returns user_ids of users who opted out of external dispatch for a dm-type notification. */
export async function getOptedOutUsers(type: NotificationType): Promise<Set<string>> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM notification_subscription WHERE notification_type = $1 AND enabled = false`,
    [type],
  );
  return new Set(res.rows.map((r) => r.user_id));
}

/** Returns user_ids of users who opted in to external dispatch for a group-type notification. */
export async function getOptedInUsers(type: NotificationType): Promise<Set<string>> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM notification_subscription WHERE notification_type = $1 AND enabled = true`,
    [type],
  );
  return new Set(res.rows.map((r) => r.user_id));
}

export async function isExternalEnabled(userId: string, type: NotificationType): Promise<boolean> {
  const res = await getPool().query<{ enabled: boolean }>(
    `SELECT enabled FROM notification_subscription WHERE user_id = $1 AND notification_type = $2`,
    [userId, type],
  );
  return res.rows.length > 0
    ? res.rows[0].enabled
    : NOTIFICATION_CONFIG[type].defaultExternalEnabled;
}

// ─── DeliveryPolicy ───────────────────────────────────────────────────────────
//
// These interfaces are RESERVED for future production-level override rules.
// The implementation hooks are in place; the data sources are not yet built.
//
// Usage in notifyUsers():
//   const policy = await resolveDeliveryPolicy(productionId, kind, userId);
//   if (shouldDeliverExternal(userPref, channel, policy)) { ... }

export type DeliveryPolicy = {
  /**
   * Channel mandate: forces delivery on these channel types regardless of user preference.
   * Hook for future production-level rules (e.g. "this production requires Feishu DM for calls").
   * Populate from: getProductionChannelMandates(productionId, kind) — not yet implemented.
   */
  mandatedChannels?: ("dm" | "group")[];

  /**
   * Opt-out block: forces external delivery even if user disabled this notification type.
   * Hook for future production-level rules (e.g. "actors cannot decline call notifications").
   * Populate from: isOptOutBlocked(productionId, userId, kind) — not yet implemented.
   */
  optOutBlocked?: boolean;
};

/**
 * Decides whether to dispatch externally for a given user, channel, and policy.
 * Call once per user per dispatch; inbox write is unconditional and not gated here.
 */
export function shouldDeliverExternal(
  userExternalEnabled: boolean,
  channel: "dm" | "group",
  policy?: DeliveryPolicy,
): boolean {
  // Channel mandate: production forces this channel on → always send.
  if (policy?.mandatedChannels?.includes(channel)) return true;
  // Opt-out blocked: user cannot decline this type → always send.
  if (policy?.optOutBlocked) return true;
  // Normal preference check.
  return userExternalEnabled;
}

/**
 * Stub: returns an empty policy until production-level rules are implemented.
 * Replace with real DB lookup when the feature is built.
 */
export async function resolveDeliveryPolicy(
  _productionId: string | null | undefined,
  _kind: NotificationType,
  _userId: string,
): Promise<DeliveryPolicy> {
  return {};
}
