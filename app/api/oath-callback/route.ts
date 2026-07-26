import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode, getUserInfo, checkIsTenantManager, TOKEN_COOKIE } from "@/lib/feishu-auth";
import { upsertFeishuUser } from "@/lib/db";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTS,
  OAUTH_STATE_COOKIE,
} from "@/lib/session";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const savedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !state || state !== savedState) {
    return Response.json({ error: "无效的授权回调，请重试" }, { status: 400 });
  }

  let tokenData;
  try {
    tokenData = await exchangeCode(code);
  } catch {
    return Response.json({ error: "Feishu 授权失败" }, { status: 502 });
  }

  const userInfo = await getUserInfo(tokenData.userAccessToken);
  if (!userInfo) {
    return Response.json({ error: "无法获取用户信息" }, { status: 502 });
  }

  const isAdmin = await checkIsTenantManager(userInfo.openId);
  const { userId } = await upsertFeishuUser(userInfo.openId, userInfo.name, userInfo.avatarUrl, isAdmin);

  const sessionId = createSession({
    userId,
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
  cookieStore.delete(OAUTH_STATE_COOKIE);

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return NextResponse.redirect(new URL("/", `${proto}://${host}`));
}
