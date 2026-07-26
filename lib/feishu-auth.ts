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

export async function getTenantAccessToken(): Promise<string> {
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
  });
  const data = await res.json() as { code: number; msg: string; tenant_access_token: string };
  if (data.code !== 0) throw new Error(`tenant_access_token: ${data.msg}`);
  return data.tenant_access_token;
}

/** Returns the bot's own open_id (needed to set bot as chat manager). */
export async function getBotOpenId(): Promise<string | null> {
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`${BASE}/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as { code: number; bot?: { open_id: string } };
    return data.bot?.open_id ?? null;
  } catch {
    return null;
  }
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

export function buildOAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    app_id: appId(),
    redirect_uri: redirectUri,
    scope: "bitable:app wiki:wiki:readonly sheets:spreadsheet offline_access",
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

// Fetch a user's email/phone/avatar using the contact API (app token).
// These fields may be null if the app lacks the relevant contact permissions.
export type FeishuContactInfo = {
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
};

export async function getUserContactInfo(openId: string): Promise<FeishuContactInfo> {
  try {
    const appToken = await getAppAccessToken();
    const res = await fetch(
      `${BASE}/contact/v3/users/${openId}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    const body = (await res.json()) as {
      code: number;
      data?: {
        user?: {
          email?: string;
          mobile?: string;
          avatar?: { avatar_240?: string; avatar_72?: string };
        };
      };
    };
    if (body.code !== 0 || !body.data?.user) return { email: null, phone: null, avatarUrl: null };
    const u = body.data.user;
    return {
      email: u.email || null,
      phone: u.mobile || null,
      avatarUrl: u.avatar?.avatar_240 ?? u.avatar?.avatar_72 ?? null,
    };
  } catch {
    return { email: null, phone: null, avatarUrl: null };
  }
}

export type FeishuSearchedUser = {
  openId: string;
  name: string;
  avatarUrl: string | null;
  enName?: string;
  hint?: string; // masked contact for disambiguation
};

// Full raw data returned by the user list API — used for sync to DB.
export type FeishuRawUser = {
  openId: string;
  name: string;
  avatarUrl: string | null;
  email: string | null;
  phone: string | null;
};

type UserListItem = {
  open_id: string;
  name: string;
  en_name?: string;
  email?: string;
  mobile?: string;
  avatar?: { avatar_240?: string; avatar_72?: string };
};

async function fetchDeptUsers(
  token: string,
  deptId: string,
  out: FeishuRawUser[],
  seen: Set<string>,
): Promise<void> {
  let pageToken = "";
  do {
    const url = new URL(`${BASE}/contact/v3/users`);
    url.searchParams.set("department_id", deptId);
    url.searchParams.set("department_id_type", "department_id");
    url.searchParams.set("user_id_type", "open_id");
    url.searchParams.set("page_size", "50");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json()) as {
      code: number; msg: string;
      data?: { has_more?: boolean; page_token?: string; items?: UserListItem[] };
    };
    if (data.code !== 0) return; // skip dept on permission/error

    for (const u of (data.data?.items ?? [])) {
      if (!seen.has(u.open_id)) {
        seen.add(u.open_id);
        out.push({
          openId: u.open_id,
          name: u.name,
          avatarUrl: u.avatar?.avatar_240 ?? u.avatar?.avatar_72 ?? null,
          email: u.email ?? null,
          phone: u.mobile ?? null,
        });
      }
    }
    pageToken = data.data?.has_more ? (data.data.page_token ?? "") : "";
  } while (pageToken);
}

async function fetchChildDeptIds(token: string, parentDeptId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  do {
    const url = new URL(`${BASE}/contact/v3/departments`);
    url.searchParams.set("parent_department_id", parentDeptId);
    url.searchParams.set("department_id_type", "department_id");
    url.searchParams.set("user_id_type", "open_id");
    url.searchParams.set("page_size", "50");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json()) as {
      code: number; msg: string;
      data?: { has_more?: boolean; page_token?: string; items?: { department_id: string }[] };
    };
    if (data.code !== 0) return ids;

    for (const d of (data.data?.items ?? [])) {
      if (d.department_id) ids.push(d.department_id);
    }
    pageToken = data.data?.has_more ? (data.data.page_token ?? "") : "";
  } while (pageToken);
  return ids;
}

// BFS over the department tree to fetch all tenant users.
// Used for the sync-all-users admin operation and as a fallback.
export async function fetchAllTenantUsersRaw(): Promise<FeishuRawUser[]> {
  const token = await getAppAccessToken();
  const users: FeishuRawUser[] = [];
  const seen = new Set<string>();
  const queue: string[] = ["0"]; // start from root department
  while (queue.length > 0) {
    const deptId = queue.shift()!;
    await fetchDeptUsers(token, deptId, users, seen);
    const children = await fetchChildDeptIds(token, deptId);
    queue.push(...children);
  }
  return users;
}

// Used by import-contacts to look up a user in the Feishu tenant directory by name.
// BFS fetches all users; caller should prefer findUserByName (local DB) first.
export async function searchUsersByName(query: string): Promise<FeishuRawUser[]> {
  const all = await fetchAllTenantUsersRaw();
  return all.filter((u) => u.name.includes(query));
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
