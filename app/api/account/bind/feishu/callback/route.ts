import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode, getUserInfo, TOKEN_COOKIE } from "@/lib/platform/feishu/feishu-auth";
import { bindPlatformIdentity, getUserProfile, attachFeishuToUser, getFeishuUser } from "@/lib/db";
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

  // 确保 feishu_user 行存在（通知系统等处有 FK 依赖），并挂到**当前登录账号**上。
  // 这里绝不能用 upsertFeishuUser——那是注册入口，遇到新 open_id 会 INSERT 一个新
  // app_user，把飞书行绑到那个凭空造出的账号上，与本人账号裂开。绑定 ≠ 注册。
  const existingFeishu = await getFeishuUser(info.openId);
  if (!existingFeishu) {
    const attached = await attachFeishuToUser(sourceUserId, info.openId, info.name, info.avatarUrl ?? null);
    if (!attached.ok) {
      switch (attached.reason) {
        case "user_has_other_feishu":
          return NextResponse.redirect(new URL("/account?bind_error=feishu_already_bound", base));
        case "openid_taken":
          // 该 open_id 已属他人（含并发抢注）：feishu_user 行必然已存在，FK 依赖满足，
          // 交给下面的 bindPlatformIdentity 走既有的 conflict → merge 流程。
          break;
      }
    }
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
