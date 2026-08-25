import { getPool } from "./pg";

export type UserInfo = { userId: string; openId: string; name: string; avatarUrl: string | null; isAdmin: boolean };

export async function upsertFeishuUser(
  openId: string,
  name: string,
  avatarUrl: string | null,
  isAdmin: boolean,
): Promise<{ userId: string; name: string; avatarUrl: string | null; isAdmin: boolean }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ user_id: string }>(
      "SELECT user_id FROM feishu_user WHERE open_id = $1",
      [openId],
    );
    let userId: string;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].user_id;
      await client.query(
        `UPDATE feishu_user
         SET name = $1, avatar_url = $2, is_super_admin = $3, updated_at = now()
         WHERE open_id = $4`,
        [name, avatarUrl, isAdmin, openId],
      );
    } else {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO app_user DEFAULT VALUES RETURNING id",
      );
      userId = rows[0].id;
      await client.query(
        `INSERT INTO feishu_user (open_id, name, avatar_url, is_super_admin, user_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [openId, name, avatarUrl, isAdmin, userId],
      );
    }
    await client.query(
      `INSERT INTO user_profile (user_id, name, avatar_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
      [userId, name, avatarUrl],
    );
    // 身份层归一：飞书与邮箱是平权的登录通道，都登记进 user_platform_identity。
    // 放在两条分支之后而非只在建号分支——存量账号（identity 缺行）下次登录即自动补齐。
    await client.query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, 'feishu', $2, true, false)
       ON CONFLICT (platform_id, platform_user_id) DO NOTHING`,
      [userId, openId],
    );
    await client.query("COMMIT");
    return { userId, name, avatarUrl, isAdmin };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 绑定用：把飞书身份挂到**已存在**的账号上，绝不建号。
 *
 * 与 upsertFeishuUser 的分工：那个是注册入口（新 open_id 会 INSERT app_user），
 * 这个是绑定入口。账户页「绑定飞书」原先误用了前者——它不接受目标 userId，于是
 * 每绑一个新飞书号就凭空造出一个立刻沦为孤儿的账号，feishu_user 指向孤儿、
 * identity 指向本人，两边裂开。绑定 ≠ 注册，两条路必须分开。
 */
export async function attachFeishuToUser(
  userId: string,
  openId: string,
  name: string,
  avatarUrl: string | null,
): Promise<{ ok: true } | { ok: false; reason: "openid_taken" | "user_has_other_feishu" }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const taken = await client.query<{ user_id: string }>(
      "SELECT user_id FROM feishu_user WHERE open_id = $1",
      [openId],
    );
    if (taken.rows.length > 0 && taken.rows[0].user_id !== userId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "openid_taken" };
    }

    // feishu_user.user_id 是 UNIQUE：一个账号至多挂一个飞书号
    const mine = await client.query<{ open_id: string }>(
      "SELECT open_id FROM feishu_user WHERE user_id = $1",
      [userId],
    );
    if (mine.rows.length > 0 && mine.rows[0].open_id !== openId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "user_has_other_feishu" };
    }

    await client.query(
      `INSERT INTO feishu_user (open_id, name, avatar_url, user_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (open_id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
      [openId, name, avatarUrl, userId],
    );
    await client.query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, 'feishu', $2, true, false)
       ON CONFLICT (platform_id, platform_user_id) DO NOTHING`,
      [userId, openId],
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getFeishuUser(openId: string): Promise<UserInfo | null> {
  const res = await getPool().query<{ user_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    "SELECT user_id, name, avatar_url, is_super_admin FROM feishu_user WHERE open_id = $1",
    [openId],
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { userId: r.user_id, openId, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin };
}
