import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode, getUserInfo, TOKEN_COOKIE } from "@/lib/platform/feishu/feishu-auth";
import { bindPlatformIdentity, getUserProfile, upsertFeishuUser, getFeishuUser } from "@/lib/db";
import { signConflictToken } from "@/lib/platform/email/email-tokens";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS, OAUTH_STATE_COOKIE } from "@/lib/session";

const BIND_SOURCE_COOKIE = "bind_source_user_id";

function redirectBase(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const base = redirectBase(req);

  const cookieStore = await cookies();
  const savedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  const sourceUserId = cookieStore.get(BIND_SOURCE_COOKIE)?.value;

  if (!code || !state || state !== savedState || !sourceUserId) {
    return NextResponse.redirect(new URL("/account?bind_error=invalid", base));
  }

  cookieStore.delete(OAUTH_STATE_COOKIE);
  cookieStore.delete(BIND_SOURCE_COOKIE);

  let tokenData;
  try {
    tokenData = await exchangeCode(code);
  } catch {
    return NextResponse.redirect(new URL("/account?bind_error=feishu_failed", base));
  }

  const info = await getUserInfo(tokenData.userAccessToken);
  if (!info) return NextResponse.redirect(new URL("/account?bind_error=feishu_failed", base));

  // Ensure feishu_user row exists (needed for FK in notification system, etc.)
  const existingFeishu = await getFeishuUser(info.openId);
  if (!existingFeishu) {
    // New Feishu identity — upsert into feishu_user bound to sourceUserId
    await upsertFeishuUser(info.openId, info.name, info.avatarUrl ?? null, false);
  }

  const bindResult = await bindPlatformIdentity(sourceUserId, "feishu", info.openId);

  // Refresh session
  const profile = await getUserProfile(sourceUserId);
  const sessionId = createSession({
    userId: sourceUserId,
    name: profile?.name ?? info.name,
    avatarUrl: profile?.avatarUrl ?? null,
    isAdmin: profile?.isAdmin ?? false,
  });
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
  cookieStore.set(TOKEN_COOKIE, tokenData.userAccessToken, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: Math.max(1, Math.floor((tokenData.expiry - Date.now()) / 1000)),
  });

  if (bindResult.result === "conflict") {
    const mergeToken = signConflictToken(sourceUserId, bindResult.existingUserId);
    const url = new URL("/account", base);
    url.searchParams.set("pending_merge", mergeToken);
    url.searchParams.set("merge_platform", "feishu");
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL("/account?bound=feishu", base));
}
