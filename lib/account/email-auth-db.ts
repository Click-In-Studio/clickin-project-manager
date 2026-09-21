import { getPool } from "../pg";

// 邮箱验证码登录（#486 从 lib/db.ts 搬出）：OTP 签发 / 消费 + 邮箱账号的唯一建号入口。

// ─── Email OTP ────────────────────────────────────────────────────────────────

export async function createEmailOtp(userId: string, email: string, code: string, ttlMs: number): Promise<void> {
  await getPool().query(
    `INSERT INTO email_otp (user_id, email, code, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`,
    [userId, email, code, `${ttlMs} milliseconds`],
  );
}

// Consume an OTP: marks it used and returns the userId, or null if invalid/expired.
export async function consumeEmailOtp(email: string, code: string): Promise<string | null> {
  const res = await getPool().query<{ user_id: string }>(
    `UPDATE email_otp
     SET used_at = now()
     WHERE email = $1 AND code = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [email, code],
  );
  return res.rows[0]?.user_id ?? null;
}

export async function upsertEmailUser(
  email: string,
  name: string,
  /** 注册邀请制（lib/account/registration-gate.ts）：正当性是邀请码时传入，在建号事务内
   *  锁行消耗 + 落流水；并发用尽则整个事务回滚，不产生账号。老用户路径不触码。 */
  registrationCode?: string,
): Promise<{ userId: string }> {
  // 防御性归一（review #308 finding 1）：email 身份全库约定存小写（两个写点的
  // 路由各自 lower 过），在唯一的账号创建入口把不变量收为本地——大小写变体
  // 不可能绕过注册门检查或裂出重复账号。
  email = email.trim().toLowerCase();
  const { consumeRegistrationCode } = await import("./registration-gate");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ user_id: string }>(
      "SELECT user_id FROM user_platform_identity WHERE platform_id = 'email' AND platform_user_id = $1",
      [email],
    );
    let userId: string;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].user_id;
    } else {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO app_user DEFAULT VALUES RETURNING id",
      );
      userId = rows[0].id;
      await client.query(
        `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
         VALUES ($1, 'email', $2, true, true)`,
        [userId, email],
      );
      await client.query(
        `INSERT INTO user_profile (user_id, name) VALUES ($1, $2)`,
        [userId, name],
      );
      if (registrationCode) {
        await consumeRegistrationCode(client, registrationCode, userId, email);
      }
    }
    await client.query("COMMIT");
    return { userId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
