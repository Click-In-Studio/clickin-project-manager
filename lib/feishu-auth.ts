// ─── Feishu API constants ─────────────────────────────────────────────────────

const BASE = "https://open.feishu.cn/open-apis";

function appId(): string {
  const v = process.env.FEISHU_APP_ID;
  if (!v) throw new Error("FEISHU_APP_ID is not set");
  return v;
}

function appSecret(): string {
  const v = process.env.FEISHU_APP_SECRET;
  if (!v) throw new Error("FEISHU_APP_SECRET is not set");
  return v;
}

// ─── Single cookie: user access token ────────────────────────────────────────

export const TOKEN_COOKIE = "feishu_ut";

type CookieJar = { cookies: { set: (name: string, value: string, opts: object) => void } };
type CookieRemover = { cookies: { delete: (name: string) => void } };

export function setUserToken(res: CookieJar, token: string, maxAge: number) {
  res.cookies.set(TOKEN_COOKIE, token, { httpOnly: true, path: "/", sameSite: "lax", maxAge });
}

export function clearUserToken(res: CookieRemover) {
  res.cookies.delete(TOKEN_COOKIE);
}

// ─── Token helpers ────────────────────────────────────────────────────────────

export async function getAppAccessToken(): Promise<string> {
  const res = await fetch(`${BASE}/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
  });
  const data = await res.json() as { code: number; msg: string; app_access_token: string };
  if (data.code !== 0) throw new Error(`app_access_token: ${data.msg}`);
  return data.app_access_token;
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

export function buildOAuthUrl(state: string): string {
  const redirectUri = process.env.FEISHU_REDIRECT_URI;
  if (!redirectUri) throw new Error("FEISHU_REDIRECT_URI is not set");
  const params = new URLSearchParams({
    app_id: appId(),
    redirect_uri: redirectUri,
    scope: "bitable:app wiki:wiki:readonly offline_access",
    state,
  });
  return `${BASE}/authen/v1/authorize?${params}`;
}

export type TokenData = {
  userAccessToken: string;
  expiry: number; // Unix ms
};

export type FeishuUserInfo = { openId: string; name: string; avatarUrl: string | null };

export async function getUserInfo(userToken: string): Promise<FeishuUserInfo | null> {
  try {
    const res = await fetch(`${BASE}/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const body = await res.json() as {
      code: number;
      data?: { open_id: string; name: string; avatar_url: string };
    };
    if (body.code !== 0 || !body.data) return null;
    return {
      openId: body.data.open_id,
      name: body.data.name,
      avatarUrl: body.data.avatar_url || null,
    };
  } catch {
    return null;
  }
}

// Uses app access token so no extra user OAuth scopes are needed.
// Requires the app to have contact:user.base:readonly in its Feishu permissions.
export async function checkIsTenantManager(openId: string): Promise<boolean> {
  try {
    const appToken = await getAppAccessToken();
    const res = await fetch(
      `${BASE}/contact/v3/users/${openId}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    const body = await res.json() as {
      code: number;
      data?: { user?: { is_tenant_manager?: boolean } };
    };
    if (body.code !== 0 || !body.data?.user) return false;
    return body.data.user.is_tenant_manager ?? false;
  } catch {
    return false;
  }
}

export async function exchangeCode(code: string): Promise<TokenData> {
  const appToken = await getAppAccessToken();
  const res = await fetch(`${BASE}/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${appToken}` },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const body = await res.json() as {
    code: number; msg: string;
    data: { access_token: string; expires_in: number };
  };
  if (body.code !== 0) throw new Error(`code exchange: ${body.msg}`);
  return {
    userAccessToken: body.data.access_token,
    expiry: Date.now() + body.data.expires_in * 1000,
  };
}
