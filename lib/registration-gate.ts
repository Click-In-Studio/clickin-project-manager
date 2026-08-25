import { getPool } from "@/lib/pg";
import type { PoolClient } from "pg";

// ─── 注册邀请制（db/add-registration-gate.sql）─────────────────────────────────
// 测试期收口「登录即注册」：email 通道在发验证码那一刻就创建账号（连邮箱验证都
// 不用过），是无邀请 0 级账号的唯一工厂。门插在唯一写点 upsertEmailUser 之前。
//
// 开关 = 环境变量 REGISTRATION_INVITE_ONLY（"1"/"true" 开启）。关闭时一切照旧，
// 正式开放注册时只动环境不动代码。
//
// 老用户登录永远不受影响（登录 ≠ 注册）。新账号的正当性：
//   1. 注册邀请码（registration_code）——与通道无关
//   2. 从有效邀请链接落地（/invite/<token> 透传）——与通道无关
//   3. 命中未失效的定向项目邀请——email 通道看 production_invite.email，
//      feishu 通道看 production_invite.feishu_open_id
//   4. 指定邮箱登记（registration_email）——**仅 email 通道**，因为飞书 OAuth
//      的 authen/v1/user_info 只返回 open_id/name/avatar，拿不到邮箱
//
// 通道平权：门按 (platform_id, platform_user_id) 判定，不再是 email 专用。
// 飞书曾以「租户应用天然限定组织成员」为由不设门，但那是单租户时代的假设——
// 飞书是与邮箱等价的登录通道，有飞书不该成为绕过邀请码的理由。

export function registrationInviteOnly(): boolean {
  const v = process.env.REGISTRATION_INVITE_ONLY;
  return v === "1" || v === "true";
}

/** 注册被拒（message 面向登录页直接展示）。 */
export class RegistrationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationDeniedError";
  }
}

/**
 * 用户声明的意图与账号实际状态不符（message 面向登录页直接展示）。
 *
 * 意图不参与判定——服务端查一次 identity 就知道该登录还是该注册。它的用处是让
 * 报错说得准：用户在登录页输了个从未注册的邮箱，该说「未注册，请先注册」，
 * 而不是默默给他建个号（那正是「登录即注册」时代的老毛病）。
 */
export class AuthIntentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthIntentMismatchError";
  }
}

/** 该平台身份是否已有账号——意图校验与注册门共用同一个口径。 */
export async function identityExists(
  platformId: RegistrationPlatform,
  platformUserId: string,
): Promise<boolean> {
  const id = normalizeIdentity(platformId, platformUserId);
  const { rows } = await getPool().query(
    "SELECT 1 FROM user_platform_identity WHERE platform_id = $1 AND platform_user_id = $2",
    [platformId, id],
  );
  return rows.length > 0;
}

export type RegistrationJustification =
  | { type: "existing" | "allowlist" | "directed_invite" | "invite_token" }
  /** 码是赢家时才在建号事务里消耗（有免费正当性就不烧码）。 */
  | { type: "code"; code: string };

/** 受注册门管辖的登录通道。新增通道时在这里扩，判定逻辑按需分支。 */
export type RegistrationPlatform = "email" | "feishu";

/** email 身份全库约定存小写；open_id 大小写敏感，原样比对。 */
function normalizeIdentity(platformId: RegistrationPlatform, raw: string): string {
  return platformId === "email" ? raw.trim().toLowerCase() : raw.trim();
}

/**
 * 判定某个平台身份能否注册。开关关闭 → null（无需正当性）；开启 → 返回命中的
 * 正当性，全部落空则抛 RegistrationDeniedError。
 *
 * platformUserId 即该通道的身份标识：email 通道是邮箱地址，feishu 通道是 open_id。
 */
export async function requireRegistrationJustification(args: {
  platformId: RegistrationPlatform;
  platformUserId: string;
  inviteToken?: string | null;
  registrationCode?: string | null;
}): Promise<RegistrationJustification | null> {
  if (!registrationInviteOnly()) return null;
  const pool = getPool();
  const { platformId } = args;
  const platformUserId = normalizeIdentity(platformId, args.platformUserId);

  // 老用户登录不是注册——两条通道同一个口径（身份统一登记在 identity 表，PR #321）
  const existing = await pool.query(
    "SELECT 1 FROM user_platform_identity WHERE platform_id = $1 AND platform_user_id = $2",
    [platformId, platformUserId],
  );
  if (existing.rows.length > 0) return { type: "existing" };

  // 指定邮箱登记（内部人员预发账号）——仅 email 通道，飞书 OAuth 拿不到邮箱
  if (platformId === "email") {
    const listed = await pool.query("SELECT 1 FROM registration_email WHERE email = $1", [platformUserId]);
    if (listed.rows.length > 0) return { type: "allowlist" };
  }

  // 定向项目邀请（未撤销、未过期、未用尽）——被定向邀请的人本身就是「指定身份」。
  // 两条通道各看各的定向列：email 看 email，feishu 看 feishu_open_id。
  const invited = await pool.query(
    `SELECT 1 FROM production_invite
     WHERE (($1 = 'email' AND LOWER(email) = $2) OR ($1 = 'feishu' AND feishu_open_id = $2))
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND (max_uses IS NULL OR used_count < max_uses)`,
    [platformId, platformUserId],
  );
  if (invited.rows.length > 0) return { type: "directed_invite" };

  // 邀请链接透传（开放/认领链接的受邀者不需要额外要码）
  if (args.inviteToken && /^[0-9a-f-]{36}$/i.test(args.inviteToken)) {
    const link = await pool.query(
      `SELECT 1 FROM production_invite
       WHERE token = $1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
         AND (max_uses IS NULL OR used_count < max_uses)`,
      [args.inviteToken],
    );
    if (link.rows.length > 0) return { type: "invite_token" };
  }

  // 注册邀请码（此处只验有效性，消耗在建号事务内 consumeRegistrationCode）
  const code = args.registrationCode?.trim();
  if (code) {
    const { rows } = await pool.query<{ used_count: number; max_uses: number; expires_at: Date | null }>(
      "SELECT used_count, max_uses, expires_at FROM registration_code WHERE code = $1",
      [code],
    );
    const c = rows[0];
    if (!c) throw new RegistrationDeniedError("邀请码不存在");
    if (c.expires_at && c.expires_at.getTime() < Date.now()) {
      throw new RegistrationDeniedError("邀请码已过期");
    }
    if (c.used_count >= c.max_uses) throw new RegistrationDeniedError("邀请码已被用完");
    return { type: "code", code };
  }

  throw new RegistrationDeniedError(
    platformId === "email"
      ? "测试期间需受邀注册：请输入邀请码，或使用被邀请的邮箱"
      : "测试期间需受邀注册：请输入邀请码",
  );
}

/**
 * 在创建账号的同一事务内消耗注册码（FOR UPDATE 锁行防并发超发）并落兑换流水。
 * 码在预检后被并发用尽时抛 RegistrationDeniedError（事务随之回滚，不产生账号）。
 */
export async function consumeRegistrationCode(
  client: PoolClient,
  code: string,
  userId: string,
  email: string,
): Promise<void> {
  const { rows } = await client.query<{ used_count: number; max_uses: number; expires_at: Date | null }>(
    "SELECT used_count, max_uses, expires_at FROM registration_code WHERE code = $1 FOR UPDATE",
    [code],
  );
  const c = rows[0];
  if (!c || (c.expires_at && c.expires_at.getTime() < Date.now()) || c.used_count >= c.max_uses) {
    throw new RegistrationDeniedError("邀请码已失效");
  }
  await client.query("UPDATE registration_code SET used_count = used_count + 1 WHERE code = $1", [code]);
  await client.query(
    "INSERT INTO registration_code_redemption (code, user_id, email) VALUES ($1, $2, $3)",
    [code, userId, email],
  );
}

// ── 未注册尝试限流（initiate 是无会话端点，按 IP 滑窗防码暴破）──────────────────
// module-level 状态是进程级的——与 Idempotency / redeem 限流同一个单进程部署假设。

const _attempts = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 15;

/** true = 已超限（调用方回 429）。仅对「开关开启」的 initiate 计数。 */
export function registrationRateLimited(ip: string): boolean {
  if (!registrationInviteOnly()) return false;
  const now = Date.now();
  const entry = _attempts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    _attempts.set(ip, { count: 1, windowStart: now });
    if (_attempts.size > 1000) {
      for (const [k, v] of _attempts) {
        if (now - v.windowStart > WINDOW_MS) _attempts.delete(k);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}
