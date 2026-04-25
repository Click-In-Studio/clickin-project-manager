import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "sid";
export const OAUTH_STATE_COOKIE = "oauth_state";

const SESSION_TTL_S = 7 * 24 * 60 * 60;

export type SessionData = {
  openId: string;
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
