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
    await client.query("COMMIT");
    return { userId, name, avatarUrl, isAdmin };
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
