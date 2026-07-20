import { getPool } from "../pg";
import { getPersonalChannel } from "./registry";
import type { PersonalChannel } from "./types";

export type NotificationTarget = {
  adapter: PersonalChannel;
  platformUserId: string;
  platformId: string;
};

/**
 * Resolve where to send a notification for a given user.
 *
 * Resolution order:
 *  1. notification_preference with scope_type='production' (if productionId given)
 *  2. notification_preference with scope_type='global'
 *  3. First user_platform_identity row (login method preferred, then oldest)
 *  4. null → skip this user
 */
export async function resolveNotificationTarget(
  userId: string,
  productionId?: string,
): Promise<NotificationTarget | null> {
  const pool = getPool();

  if (productionId) {
    const res = await pool.query<{ platform_id: string; platform_user_id: string }>(
      `SELECT upi.platform_id, upi.platform_user_id
       FROM notification_preference np
       JOIN user_platform_identity upi ON upi.id = np.platform_identity_id
       WHERE np.user_id = $1 AND np.scope_type = 'production' AND np.scope_id = $2`,
      [userId, productionId],
    );
    if (res.rows[0]) return toTarget(res.rows[0]);
  }

  const globalRes = await pool.query<{ platform_id: string; platform_user_id: string }>(
    `SELECT upi.platform_id, upi.platform_user_id
     FROM notification_preference np
     JOIN user_platform_identity upi ON upi.id = np.platform_identity_id
     WHERE np.user_id = $1 AND np.scope_type = 'global' AND np.scope_id = ''`,
    [userId],
  );
  if (globalRes.rows[0]) return toTarget(globalRes.rows[0]);

  const anyRes = await pool.query<{ platform_id: string; platform_user_id: string }>(
    `SELECT platform_id, platform_user_id
     FROM user_platform_identity
     WHERE user_id = $1
     ORDER BY is_login_method DESC, created_at ASC
     LIMIT 1`,
    [userId],
  );
  if (anyRes.rows[0]) return toTarget(anyRes.rows[0]);

  return null;
}

/**
 * Batch-resolve targets for multiple users. Runs resolves in parallel.
 * Users with no reachable platform identity are omitted from the result map.
 */
export async function batchResolveNotificationTargets(
  userIds: string[],
  productionId?: string,
): Promise<Map<string, NotificationTarget>> {
  if (!userIds.length) return new Map();
  const pairs = await Promise.all(
    userIds.map(async (userId) => [userId, await resolveNotificationTarget(userId, productionId)] as const),
  );
  const result = new Map<string, NotificationTarget>();
  for (const [userId, target] of pairs) {
    if (target) result.set(userId, target);
  }
  return result;
}

function toTarget(row: { platform_id: string; platform_user_id: string }): NotificationTarget | null {
  try {
    return {
      adapter: getPersonalChannel(row.platform_id),
      platformUserId: row.platform_user_id,
      platformId: row.platform_id,
    };
  } catch {
    return null;
  }
}
