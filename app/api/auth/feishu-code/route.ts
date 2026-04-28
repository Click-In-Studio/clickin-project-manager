import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode, getUserInfo, checkIsTenantManager, TOKEN_COOKIE } from "@/lib/feishu-auth";
import { upsertFeishuUser } from "@/lib/db";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json() as { code?: string };
  if (!body.code) return Response.json({ error: "missing code" }, { status: 400 });

  let tokenData;
  try {
    tokenData = await exchangeCode(body.code);
  } catch {
    return Response.json({ error: "code exchange failed" }, { status: 502 });
  }

  const userInfo = await getUserInfo(tokenData.userAccessToken);
  if (!userInfo) return Response.json({ error: "user info failed" }, { status: 502 });

  const isAdmin = await checkIsTenantManager(userInfo.openId);
  await upsertFeishuUser(userInfo.openId, userInfo.name, userInfo.avatarUrl, isAdmin);

  const sessionId = createSession({
    openId: userInfo.openId,
    name: userInfo.name,
    avatarUrl: userInfo.avatarUrl,
    isAdmin,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
  cookieStore.set(TOKEN_COOKIE, tokenData.userAccessToken, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: Math.max(1, Math.floor((tokenData.expiry - Date.now()) / 1000)),
  });

  return Response.json({ ok: true });
}
