import { type NextRequest, NextResponse } from "next/server";
import { getPersonalChannel } from "@/lib/platform/registry";
import { generateOAuthState, OAUTH_STATE_COOKIE, OAUTH_CTX_COOKIE, type OAuthContext } from "@/lib/session";
import { RegistrationDeniedError, registrationRateLimited } from "@/lib/registration-gate";

function requestBaseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

type Params = { params: Promise<{ platform: string }> };

// GET — OAuth platforms: generate state cookie and redirect to auth URL
export async function GET(req: NextRequest, { params }: Params) {
  const { platform } = await params;
  let ch;
  try {
    ch = getPersonalChannel(platform);
  } catch {
    return Response.json({ error: "unknown platform" }, { status: 404 });
  }

  const state = generateOAuthState();
  const baseUrl = requestBaseUrl(req);
  const redirectUri = `${baseUrl}/api/auth/${platform}/callback`;
  const url = ch.generateAuthUrl(state, redirectUri);

  // 注册凭据要跨越「跳到飞书再跳回来」这一次往返。放 cookie 而不是编进 state：
  // state 会出现在授权 URL 里，等于把邀请码交给第三方记进日志。这些 query 参数
  // 来自我们自己的登录页，本站内传递不构成新的暴露。
  const { searchParams } = req.nextUrl;
  const ctx: OAuthContext = {
    nonce: state,
    registrationCode: searchParams.get("reg_code")?.trim() || undefined,
    inviteToken: searchParams.get("invite_token")?.trim() || undefined,
    next: searchParams.get("next")?.trim() || undefined,
  };

  // cookie 直接挂在响应上而不是 next/headers 的 cookies()——后者要求请求作用域，
  // 路由函数便无法被直接单测；挂响应也更直白：这次跳转带走哪些 cookie 一目了然。
  const oauthCookie = { httpOnly: true, path: "/", sameSite: "lax", maxAge: 600 } as const;
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, oauthCookie);
  res.cookies.set(OAUTH_CTX_COOKIE, JSON.stringify(ctx), oauthCookie);
  return res;
}

// POST — Credential platforms: initiate login (magic link, OTP, etc.)
export async function POST(req: NextRequest, { params }: Params) {
  const { platform } = await params;
  let ch;
  try {
    ch = getPersonalChannel(platform);
  } catch {
    return Response.json({ error: "unknown platform" }, { status: 404 });
  }

  if (!ch.initiateLogin) {
    return Response.json({ error: "platform does not support credential login" }, { status: 400 });
  }

  let body: Record<string, string>;
  try {
    body = await req.json() as Record<string, string>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  // 注册邀请制：initiate 无会话，按 IP 滑窗限流防注册码暴破（开关关闭时不计数）。
  // IP 取信链（review #308 finding 2）：优先 X-Real-IP（nginx 以 $remote_addr 覆写，
  // 不可伪造）；退而取 X-Forwarded-For **末段**（$proxy_add_x_forwarded_for 是追加
  // 语义，首段是客户端自报的、可伪造，末段才是我们的反代补的真实来源）。
  const xff = req.headers.get("x-forwarded-for");
  const ip = req.headers.get("x-real-ip")?.trim()
    || xff?.split(",").at(-1)?.trim()
    || "unknown";
  if (registrationRateLimited(ip)) {
    return Response.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  const baseUrl = requestBaseUrl(req);
  try {
    await ch.initiateLogin(body, { baseUrl });
  } catch (e) {
    if (e instanceof RegistrationDeniedError) {
      return Response.json({ error: e.message }, { status: 403 });
    }
    console.error(`[auth/${platform}/initiate]`, e);
    return Response.json({ error: "failed to initiate login" }, { status: 502 });
  }

  return Response.json({ sent: true });
}
