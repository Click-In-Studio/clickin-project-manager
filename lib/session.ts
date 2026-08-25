import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "sid";
export const OAUTH_STATE_COOKIE = "oauth_state";
/** OAuth 发起时的上下文：跨越「跳到第三方再跳回来」这一次往返。
 *  与 state 分开存：state 那个 cookie 还被账号绑定流程按纯字符串比对，格式不能动。
 *  凭据只走本站 cookie，不编码进 state——否则会经由授权 URL 落进第三方日志。 */
export const OAUTH_CTX_COOKIE = "oauth_ctx";

export type OAuthContext = {
  nonce: string;
  /** 注册邀请码（用户在注册页填的） */
  registrationCode?: string;
  /** 邀请链接透传的 token（/invite/<token> 落地时带上） */
  inviteToken?: string;
  /** 登录后回跳目标，读出后必须再走一次站内路径校验 */
  next?: string;
};

const SESSION_TTL_S = 7 * 24 * 60 * 60;

export type SessionData = {
  userId: string;  // app_user.id (UUID)
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  expiry: number;
};

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) console.warn("[session] SESSION_SECRET not set — using insecure dev default");
  return s ?? "dev-secret-change-in-production";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

type CookieSource = { get: (name: string) => { value: string } | undefined };

export function createSession(data: Omit<SessionData, "expiry">): string {
  const session: SessionData = { ...data, expiry: Date.now() + SESSION_TTL_S * 1000 };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function getSession(cookies: CookieSource): SessionData | null {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (sig !== sign(payload)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as SessionData;
    if (data.expiry < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// Logout just clears the cookie on the client side — no server store to clean up.
export function destroySession(_cookies: CookieSource): void {}

export function generateOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  maxAge: SESSION_TTL_S,
};
