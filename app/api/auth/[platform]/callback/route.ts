import { type NextRequest, NextResponse } from "next/server";
import { getPersonalChannel } from "@/lib/platform/registry";
import {
  createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS,
  OAUTH_STATE_COOKIE, OAUTH_CTX_COOKIE, type OAuthContext,
} from "@/lib/session";
import {
  requireRegistrationJustification,
  RegistrationDeniedError,
  type RegistrationPlatform,
} from "@/lib/registration-gate";

type Params = { params: Promise<{ platform: string }> };

/** 受注册门管辖的通道；其余平台维持原样放行。 */
function gatedPlatform(platform: string): RegistrationPlatform | null {
  return platform === "email" || platform === "feishu" ? platform : null;
}

/** 仅允许站内相对路径，防 open redirect（与登录页 loginDest 同规则）。 */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function GET(req: NextRequest, { params }: Params) {
  const { platform } = await params;
  let ch;
  try {
    ch = getPersonalChannel(platform);
  } catch {
    return Response.json({ error: "unknown platform" }, { status: 404 });
  }

  const { searchParams } = req.nextUrl;

  // OAuth platforms pass code + state; credential platforms pass token
  const code = searchParams.get("code") ?? searchParams.get("token");
  if (!code) {
    return Response.json({ error: "missing code or token" }, { status: 400 });
  }

  // Verify OAuth state if present
  const state = searchParams.get("state");
  if (state !== null) {
    const savedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
    if (state !== savedState) {
      return Response.json({ error: "invalid state" }, { status: 400 });
    }
  }

  // 发起时存下的上下文（邀请码 / 邀请 token / 回跳目标）——跨越这一次第三方往返
  let ctx: OAuthContext | null = null;
  const rawCtx = req.cookies.get(OAUTH_CTX_COOKIE)?.value;
  if (rawCtx) {
    try {
      const parsed = JSON.parse(rawCtx) as OAuthContext;
      // nonce 必须与本次 state 对上，防止旧的/别处的上下文被拿来用
      if (!state || parsed.nonce === state) ctx = parsed;
    } catch { /* 坏 cookie 当作没有上下文 */ }
  }

  // 反代下以 x-forwarded-* 为准；两者都缺时回落到请求自身的 origin，
  // 免得拼出 "https://" 这种非法 URL 直接抛 TypeError。
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : req.nextUrl.origin;

  let loginResult;
  const gated = gatedPlatform(platform);
  if (ch.completeLogin && gated) {
    // 三段式：换取身份 → 过注册门 → 建号。performLogin 把后两步捆死，门无处安放。
    let identity;
    try {
      identity = await ch.handleAuthCallback(code);
    } catch (e) {
      console.error(`[auth/${platform}/callback] identity`, e);
      return NextResponse.redirect(new URL("/login?error=auth_failed", origin));
    }

    try {
      // 老用户命中 existing 直接放行；新身份则要求正当性（邀请码 / 邀请 token /
      // 定向邀请）。开关关闭时这里返回 null，一切照旧。
      await requireRegistrationJustification({
        platformId: gated,
        platformUserId: identity.platformUserId,
        inviteToken: ctx?.inviteToken,
        registrationCode: ctx?.registrationCode,
      });
    } catch (e) {
      if (e instanceof RegistrationDeniedError) {
        // 未建号即返回——「注册由本人显式完成」的前提是没有正当性时什么都不落库
        const url = new URL("/login", origin);
        url.searchParams.set("error", e.message);
        if (ctx?.next) url.searchParams.set("next", safeNext(ctx.next));
        const denied = NextResponse.redirect(url);
        denied.cookies.delete(OAUTH_STATE_COOKIE);
        denied.cookies.delete(OAUTH_CTX_COOKIE);
        return denied;
      }
      console.error(`[auth/${platform}/callback] gate`, e);
      return NextResponse.redirect(new URL("/login?error=auth_failed", origin));
    }

    loginResult = await ch.completeLogin(identity);
  } else {
    try {
      loginResult = await ch.performLogin(code);
    } catch (e) {
      console.error(`[auth/${platform}/callback]`, e);
      return NextResponse.redirect(new URL("/login?error=auth_failed", origin));
    }
  }

  const sessionId = createSession({
    userId: loginResult.userId,
    name: loginResult.name,
    avatarUrl: loginResult.avatarUrl,
    isAdmin: loginResult.isAdmin,
  });

  // 同 initiate：cookie 挂响应而非 next/headers，路由才能被直接单测
  const res = NextResponse.redirect(new URL(safeNext(ctx?.next), origin));
  res.cookies.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
  res.cookies.delete(OAUTH_STATE_COOKIE);
  res.cookies.delete(OAUTH_CTX_COOKIE);

  for (const c of loginResult.extraCookies ?? []) {
    res.cookies.set(c.name, c.value, c.opts as Parameters<typeof res.cookies.set>[2]);
  }

  return res;
}
