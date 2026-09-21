import { getPool } from "../pg";

// 账号本体（#486 从 lib/db.ts 搬出）：user_profile、平台身份绑定、账号摘要与合并。
// 飞书专属查询在 db-feishu.ts，邮箱验证码登录在 email-auth-db.ts。

// ─── user_profile ──────────────────────────────────────────────────────────────

export async function upsertUserProfile(
  userId: string,
  name: string,
  avatarUrl: string | null,
  extra?: { displayName?: string | null; bio?: string | null; preferredPlatform?: string | null },
): Promise<void> {
  const sets: string[] = ["name = EXCLUDED.name", "avatar_url = EXCLUDED.avatar_url", "updated_at = now()"];
  const vals: unknown[] = [userId, name, avatarUrl];
  if (extra?.displayName !== undefined) { sets.push(`display_name = $${vals.push(extra.displayName)}`); }
  if (extra?.bio !== undefined) { sets.push(`bio = $${vals.push(extra.bio)}`); }
  if (extra?.preferredPlatform !== undefined) { sets.push(`preferred_platform = $${vals.push(extra.preferredPlatform)}`); }
  await getPool().query(
    `INSERT INTO user_profile (user_id, name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET ${sets.join(", ")}`,
    vals,
  );
}

// Upsert or clear the global notification_preference for a user.
// Called whenever the user changes their preferred_platform in profile settings.
export async function syncGlobalNotificationPreference(
  userId: string,
  platformId: string | null,
): Promise<void> {
  const pool = getPool();
  if (!platformId) {
    await pool.query(
      `DELETE FROM notification_preference WHERE user_id = $1 AND scope_type = 'global' AND scope_id = ''`,
      [userId],
    );
    return;
  }
  const upiRes = await pool.query<{ id: string }>(
    `SELECT id FROM user_platform_identity WHERE user_id = $1 AND platform_id = $2 LIMIT 1`,
    [userId, platformId],
  );
  const upiId = upiRes.rows[0]?.id;
  if (!upiId) return; // platform not bound yet — silently skip
  await pool.query(
    `INSERT INTO notification_preference (user_id, scope_type, scope_id, platform_identity_id)
     VALUES ($1, 'global', '', $2)
     ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET platform_identity_id = EXCLUDED.platform_identity_id`,
    [userId, upiId],
  );
}

/** 用户邮箱：email identity 任一（primary 优先——未设 primary 也要尽量给出邮箱，
 *  水印/溯源场景宁可有）→ feishu_user.email fallback。 */
export async function getUserPrimaryEmail(userId: string): Promise<string | null> {
  const res = await getPool().query<{ email: string | null }>(
    `SELECT COALESCE(
       (SELECT upi.platform_user_id FROM user_platform_identity upi
        WHERE upi.user_id = $1 AND upi.platform_id = 'email'
        ORDER BY upi.is_primary DESC, upi.created_at DESC LIMIT 1),
       (SELECT fu.email FROM feishu_user fu WHERE fu.user_id = $1)
     ) AS email`,
    [userId],
  );
  return res.rows[0]?.email ?? null;
}

export async function getUserProfile(
  userId: string,
): Promise<{ name: string; displayName: string | null; bio: string | null; preferredPlatform: string | null; avatarUrl: string | null; isAdmin: boolean } | null> {
  const res = await getPool().query<{ name: string; display_name: string | null; bio: string | null; preferred_platform: string | null; avatar_url: string | null; is_super_admin: boolean | null }>(
    `SELECT up.name, up.display_name, up.bio, up.preferred_platform, up.avatar_url, fu.is_super_admin
     FROM user_profile up
     LEFT JOIN feishu_user fu ON fu.user_id = up.user_id
     WHERE up.user_id = $1`,
    [userId],
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    name: r.name,
    displayName: r.display_name,
    bio: r.bio,
    preferredPlatform: r.preferred_platform,
    avatarUrl: r.avatar_url,
    isAdmin: r.is_super_admin ?? false,
  };
}

export async function getUserIdentities(
  userId: string,
): Promise<{ id: string; platformId: string; platformUserId: string; label: string | null; isLoginMethod: boolean; isPrimary: boolean; displayName: string | null; avatarUrl: string | null }[]> {
  const res = await getPool().query<{
    id: string; platform_id: string; platform_user_id: string; label: string | null;
    is_login_method: boolean; is_primary: boolean; fu_name: string | null; fu_avatar: string | null;
  }>(
    `SELECT upi.id, upi.platform_id, upi.platform_user_id, upi.label, upi.is_login_method, upi.is_primary,
            fu.name AS fu_name, fu.avatar_url AS fu_avatar
     FROM user_platform_identity upi
     LEFT JOIN feishu_user fu ON fu.user_id = upi.user_id AND upi.platform_id = 'feishu'
     WHERE upi.user_id = $1
     ORDER BY upi.platform_id, upi.is_primary DESC, upi.created_at`,
    [userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    platformId: r.platform_id,
    platformUserId: r.platform_user_id,
    label: r.label,
    isLoginMethod: r.is_login_method,
    isPrimary: r.is_primary,
    displayName: r.fu_name ?? null,
    avatarUrl: r.fu_avatar ?? null,
  }));
}

export async function getUserByPlatformIdentity(
  platformId: string,
  platformUserId: string,
): Promise<string | null> {
  const res = await getPool().query<{ user_id: string }>(
    "SELECT user_id FROM user_platform_identity WHERE platform_id = $1 AND platform_user_id = $2",
    [platformId, platformUserId],
  );
  return res.rows[0]?.user_id ?? null;
}

// Add a new platform identity to an existing user. Returns 'bound' or 'conflict' (identity already belongs to a DIFFERENT user).
export async function bindPlatformIdentity(
  userId: string,
  platformId: string,
  platformUserId: string,
): Promise<{ result: "bound" } | { result: "conflict"; existingUserId: string }> {
  const pool = getPool();
  const existing = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM user_platform_identity WHERE platform_id = $1 AND platform_user_id = $2",
    [platformId, platformUserId],
  );
  if (existing.rows.length > 0) {
    const existingUserId = existing.rows[0].user_id;
    if (existingUserId === userId) return { result: "bound" }; // already bound
    return { result: "conflict", existingUserId };
  }
  if (platformId === "email") {
    const hasPrimary = await pool.query(
      `SELECT 1 FROM user_platform_identity WHERE user_id = $1 AND platform_id = 'email' AND is_primary = true`,
      [userId],
    );
    await pool.query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, $2, $3, true, $4)`,
      [userId, platformId, platformUserId, hasPrimary.rows.length === 0],
    );
  } else {
    await pool.query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method)
       VALUES ($1, $2, $3, true)`,
      [userId, platformId, platformUserId],
    );
  }
  return { result: "bound" };
}

export async function setPrimaryEmail(userId: string, upiId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Verify the target UPI belongs to this user and is an email identity
    const check = await client.query<{ id: string }>(
      `SELECT id FROM user_platform_identity WHERE id = $1 AND user_id = $2 AND platform_id = 'email'`,
      [upiId, userId],
    );
    if (!check.rows.length) throw new Error("identity not found");
    await client.query(
      `UPDATE user_platform_identity SET is_primary = false WHERE user_id = $1 AND platform_id = 'email'`,
      [userId],
    );
    await client.query(
      `UPDATE user_platform_identity SET is_primary = true WHERE id = $1`,
      [upiId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function unbindEmail(userId: string, upiId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upi = await client.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM user_platform_identity WHERE id = $1 AND user_id = $2 AND platform_id = 'email'`,
      [upiId, userId],
    );
    if (!upi.rows.length) throw new Error("identity not found");

    // Count remaining login methods after removal
    const remaining = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_platform_identity WHERE user_id = $1 AND id != $2 AND is_login_method = true`,
      [userId, upiId],
    );
    if (Number(remaining.rows[0].count) === 0) throw new Error("last login method");

    // If removing primary and other emails exist, auto-promote the oldest other email
    if (upi.rows[0].is_primary) {
      await client.query(
        `UPDATE user_platform_identity SET is_primary = true
         WHERE id = (
           SELECT id FROM user_platform_identity
           WHERE user_id = $1 AND platform_id = 'email' AND id != $2
           ORDER BY created_at ASC LIMIT 1
         )`,
        [userId, upiId],
      );
    }

    await client.query(`DELETE FROM user_platform_identity WHERE id = $1`, [upiId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface AccountSummary {
  userId: string;
  name: string | null;
  identities: { platformId: string; label: string | null }[];
  productionCount: number;
}

export async function getAccountSummary(userId: string): Promise<AccountSummary | null> {
  const pool = getPool();
  const [nameRow, idRows, countRow] = await Promise.all([
    pool.query<{ name: string | null }>(
      `SELECT name FROM user_profile WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ platform_id: string; label: string | null; fu_name: string | null }>(
      `SELECT upi.platform_id,
              upi.label,
              fu.name AS fu_name
         FROM user_platform_identity upi
         LEFT JOIN feishu_user fu ON fu.user_id = upi.user_id AND upi.platform_id = 'feishu'
        WHERE upi.user_id = $1`,
      [userId],
    ),
    pool.query<{ count: string }>(
      // 「参与 N 个项目」——在职口径。离组/停用的不计。
      `SELECT COUNT(*)::text AS count FROM production_member
        WHERE user_id = $1 AND status = 'active'`,
      [userId],
    ),
  ]);
  if (nameRow.rows.length === 0 && idRows.rows.length === 0) return null;
  return {
    userId,
    name: nameRow.rows[0]?.name ?? null,
    identities: idRows.rows.map(r => ({
      platformId: r.platform_id,
      label: r.fu_name ?? r.label,
    })),
    productionCount: parseInt(countRow.rows[0]?.count ?? "0", 10),
  };
}

export async function getSharedProductions(
  userId1: string,
  userId2: string,
): Promise<{ id: string; name: string }[]> {
  const res = await getPool().query<{ id: string; name: string }>(
    `SELECT p.id, p.name
       FROM production_member pm1
       JOIN production_member pm2 ON pm1.production_id = pm2.production_id
       JOIN production p ON p.id = pm1.production_id
      WHERE pm1.user_id = $1 AND pm2.user_id = $2
        AND pm1.status = 'active' AND pm2.status = 'active'`,
    [userId1, userId2],
  );
  return res.rows;
}

// Merge deleteUserId INTO keepUserId.
// Precondition: no shared productions (call getSharedProductions first).
// Transfers all user-linked data. Non-CASCADE FKs are updated before deletion.
export async function mergeAccounts(keepUserId: string, deleteUserId: string): Promise<void> {
  if (keepUserId === deleteUserId) return;

  const shared = await getSharedProductions(keepUserId, deleteUserId);
  if (shared.length > 0) {
    throw new Error(`Cannot merge: both accounts are in ${shared.map(p => p.name).join(", ")}`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update RESTRICT (non-CASCADE) FKs — must happen before DELETE
    await client.query(`UPDATE cue_list SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE production_event SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    // report/note 作者已随 wiki-split 迁入 wiki.created_by
    await client.query(`UPDATE wiki SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE wiki_revision SET author_user_id = $1 WHERE author_user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE asset SET uploader_user_id = $1 WHERE uploader_user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE node_mount SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE node SET created_by = $1 WHERE created_by = $2`, [keepUserId, deleteUserId]);
    // asset_share_token 化石表已删（#420）：分享 token 是无状态 HMAC，无行可搬
    // production_member_status_audit.actor_id 是 NO ACTION 的 FK（#141）：漏了这条，
    // 任何处置过别人成员状态的账号都无法被合并——DELETE app_user 直接撞 FK 违例。
    await client.query(
      `UPDATE production_member_status_audit SET actor_id = $1 WHERE actor_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 2. Transfer production memberships (safe: no shared productions)
    await client.query(
      // status 三列必须一并搬（#141）：漏了的话 DEFAULT 'active' 会把一个 suspended
      // 或 exited 的成员在合并账号时悄悄复活成在职，而且不留任何审计行。
      `INSERT INTO production_member
         (production_id, user_id, roles, photo_url, added_at,
          status, status_source, status_changed_at, status_changed_by)
       SELECT production_id, $1, roles, photo_url, added_at,
              status, status_source, status_changed_at, status_changed_by
         FROM production_member WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM production_member WHERE user_id = $1`, [deleteUserId]);
    // 状态轨迹跟着身份走。user_id 是 ON DELETE CASCADE，不改指向的话下面删旧
    // app_user 时整条轨迹会被静默级联删掉——合并账号成了抹痕迹的第二条路。
    await client.query(
      `UPDATE production_member_status_audit SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );
    await client.query(
      `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
       SELECT production_id, $1, permission, granted FROM production_member_permission WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM production_member_permission WHERE user_id = $1`, [deleteUserId]);

    // 3. Transfer event-scoped data (no shared productions → no PK conflicts)
    await client.query(`UPDATE event_call_time SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(
      `INSERT INTO event_participant (id, event_id, user_id, name, department_id, role)
       SELECT id, event_id, $1, name, department_id, role FROM event_participant WHERE user_id = $2
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM event_participant WHERE user_id = $1`, [deleteUserId]);
    await client.query(
      `UPDATE production_dept_member pdm SET user_id = $1 WHERE user_id = $2
       AND NOT EXISTS (SELECT 1 FROM production_dept_member p2 WHERE p2.user_id = $1 AND p2.dept_id = pdm.dept_id)`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM production_dept_member WHERE user_id = $1`, [deleteUserId]);
    await client.query(`UPDATE event_stage_manager SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE schedule_item_participant SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE task_assignee SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE event_report_read SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE wiki_comment SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    await client.query(`UPDATE comment SET user_id = $1 WHERE user_id = $2`, [keepUserId, deleteUserId]);
    // Transfer cue list production_member_grant rows (cue_list_permission/role tables dropped in Phase 4)
    await client.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by, is_revoked, revoked_reason, expires_at)
       SELECT production_id, $1, resource_type, resource_id, resource_sub,
              permission_level, grant_source, confirmed_by, is_revoked, revoked_reason, expires_at
       FROM production_member_grant
       WHERE user_id = $2 AND resource_type = 'cue_list'
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(
      `DELETE FROM production_member_grant WHERE user_id = $1 AND resource_type = 'cue_list'`,
      [deleteUserId],
    );

    // 4. Transfer platform identities (before notification_preference, which FK-references them)
    await client.query(
      `UPDATE user_platform_identity SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 5. Transfer notification settings (may conflict regardless of productions)
    await client.query(
      `INSERT INTO notification_preference (user_id, scope_type, scope_id, platform_identity_id)
       SELECT $1, scope_type, scope_id, platform_identity_id FROM notification_preference WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM notification_preference WHERE user_id = $1`, [deleteUserId]);
    await client.query(
      `INSERT INTO notification_subscription (user_id, notification_type, enabled, updated_at)
       SELECT $1, notification_type, enabled, updated_at FROM notification_subscription WHERE user_id = $2
       ON CONFLICT DO NOTHING`,
      [keepUserId, deleteUserId],
    );
    await client.query(`DELETE FROM notification_subscription WHERE user_id = $1`, [deleteUserId]);

    // 6. Transfer feishu_user (keep keepUserId's row if both exist)
    await client.query(
      `DELETE FROM feishu_user WHERE user_id = $1
         AND EXISTS (SELECT 1 FROM feishu_user WHERE user_id = $2)`,
      [deleteUserId, keepUserId],
    );
    await client.query(
      `UPDATE feishu_user SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 7. Transfer notifications
    await client.query(
      `UPDATE user_notification SET user_id = $1 WHERE user_id = $2`,
      [keepUserId, deleteUserId],
    );

    // 8. Delete old profile then user (CASCADE handles email_otp and any remaining rows)
    await client.query(`DELETE FROM user_profile WHERE user_id = $1`, [deleteUserId]);
    await client.query(`DELETE FROM app_user WHERE id = $1`, [deleteUserId]);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
