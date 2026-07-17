import { getPool } from "./pg";

// ─── Notification type registry ───────────────────────────────────────────────
// Add new types here as notification nodes are introduced.
// channel: 'dm'    → user receives it as a personal DM (default on, can opt out)
// channel: 'group' → sent to a group chat that @mentions the user (default off,
//                    user can opt in to also receive a personal DM copy)

export const NOTIFICATION_CONFIG = {
  daily_call:       { label: "日 Call 提醒",   description: "演出前一天发送，含你的 call 时间和当天日程", channel: "dm"    as const, defaultEnabled: true  },
  weekly_call:      { label: "周 Call 汇总",   description: "每周日发送，含本周所有演出和待处理技术需求",  channel: "dm"    as const, defaultEnabled: true  },
  report_broadcast: { label: "报告发布通知",   description: "报告发布时推送给所有关注者和参与者",          channel: "dm"    as const, defaultEnabled: true  },
  report_mention:   { label: "报告 @ 提及",    description: "报告或部门备注中被 @ 时收到通知",           channel: "dm"    as const, defaultEnabled: true  },
  comment_mention:  { label: "评论 @ 提及",    description: "剧本或 cue 评论中被 @ 时收到通知",         channel: "dm"    as const, defaultEnabled: true  },
  cue_warning:      { label: "Cue 报警通知",   description: "你负责的 Cue 表中有 Cue 被标记为报警时通知", channel: "dm"    as const, defaultEnabled: true  },
  tech_req_poc:     { label: "技术需求私信",   description: "作为 POC 被 @ 时，额外收到机器人私信副本",   channel: "group" as const, defaultEnabled: false },
} as const;

export type NotificationType = keyof typeof NOTIFICATION_CONFIG;
export const ALL_NOTIFICATION_TYPES = Object.keys(NOTIFICATION_CONFIG) as NotificationType[];

export type NotifPref = {
  type: NotificationType;
  label: string;
  description: string;
  channel: "dm" | "group";
  defaultEnabled: boolean;
  enabled: boolean;
};

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** All prefs for one user, with defaults filled in for unset types. */
export async function getUserPrefs(openId: string): Promise<NotifPref[]> {
  const res = await getPool().query<{ notification_type: string; enabled: boolean }>(
    `SELECT notification_type, enabled FROM notification_subscription WHERE open_id = $1`,
    [openId],
  );
  const stored = new Map(res.rows.map((r) => [r.notification_type, r.enabled]));
  return ALL_NOTIFICATION_TYPES.map((type) => {
    const cfg = NOTIFICATION_CONFIG[type];
    return { type, ...cfg, enabled: stored.has(type) ? stored.get(type)! : cfg.defaultEnabled };
  });
}

/** Set one pref. When value matches the default, the row is deleted (keep the table sparse). */
export async function setUserPref(
  openId: string,
  type: NotificationType,
  enabled: boolean,
): Promise<void> {
  if (enabled === NOTIFICATION_CONFIG[type].defaultEnabled) {
    await getPool().query(
      `DELETE FROM notification_subscription WHERE open_id = $1 AND notification_type = $2`,
      [openId, type],
    );
  } else {
    await getPool().query(
      `INSERT INTO notification_subscription (open_id, notification_type, enabled, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (open_id, notification_type)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [openId, type, enabled],
    );
  }
}

/**
 * Batch: set of open_ids that have OPTED OUT of a DM-type notification.
 * Use before a dispatch loop to skip users who don't want this notification.
 */
export async function getOptedOutUsers(type: NotificationType): Promise<Set<string>> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT open_id FROM notification_subscription WHERE notification_type = $1 AND enabled = false`,
    [type],
  );
  return new Set(res.rows.map((r) => r.open_id));
}

/**
 * Batch: set of open_ids that have OPTED IN to a group-type notification extra DM.
 * Use after sending a group chat notification to also send personal DMs.
 */
export async function getOptedInUsers(type: NotificationType): Promise<Set<string>> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT open_id FROM notification_subscription WHERE notification_type = $1 AND enabled = true`,
    [type],
  );
  return new Set(res.rows.map((r) => r.open_id));
}

/**
 * Single-user check. Prefer the batch variants in dispatch loops.
 * Used in hot-path per-mention checks.
 */
export async function isNotifEnabled(openId: string, type: NotificationType): Promise<boolean> {
  const res = await getPool().query<{ enabled: boolean }>(
    `SELECT enabled FROM notification_subscription WHERE open_id = $1 AND notification_type = $2`,
    [openId, type],
  );
  return res.rows.length > 0 ? res.rows[0].enabled : NOTIFICATION_CONFIG[type].defaultEnabled;
}
