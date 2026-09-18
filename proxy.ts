import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "sid";

// Paths that don't require a session cookie
// /help：使用手册（#531）是公开帮助中心，不登录可看、可外发给潜在客户
const PUBLIC_PREFIXES = ["/login", "/unauthorized", "/help", "/api/auth/", "/api/oath-callback", "/api/email-inbound", "/api/internal/", "/api/feishu-webhook", "/api/account/bind/", "/api/rsvp"];

// Paths that accept a card token (?t=...) in lieu of a session
const TOKEN_ALLOWED_PREFIXES = ["/my/weekly-call", "/my/daily-call"];

export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (hasSession) return NextResponse.next();

  const hasToken = TOKEN_ALLOWED_PREFIXES.some(p => pathname.startsWith(p)) && searchParams.has("t");
  if (hasToken) return NextResponse.next();

  // 带上原目的地：登录页靠 ?next 回跳，也靠它从 /invite/<token> 里抠出邀请 token
  // 作注册正当性（app/login/LoginClient.tsx inviteTokenFromDest）。这一层先于页面
  // 拦截，此前把 search 清空，页面层自己写的 redirect(`/login?next=…`) 从未被走到——
  // 受邀者登录页拿不到 token，只能被要邀请码（#516）。
  // 下游只认站内相对路径（loginDest / callback safeNext），这里不构成 open redirect。
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const next = loginNext(pathname, req.nextUrl.search);
  if (next) loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

/** 登录后回跳目标；根路径与 API 请求（浏览器不会导航到那里）不带。 */
export function loginNext(pathname: string, search: string): string | undefined {
  if (pathname === "/" || pathname.startsWith("/api/")) return undefined;
  return `${pathname}${search}`;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
