import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "sid";

// Paths that don't require a session cookie
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/oath-callback", "/api/email-inbound", "/api/internal/", "/api/feishu-webhook", "/api/account/bind/"];

// Paths that accept a card token (?t=...) in lieu of a session
const TOKEN_ALLOWED_PREFIXES = ["/my/weekly-call", "/my/daily-call"];

export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (hasSession) return NextResponse.next();

  const hasToken = TOKEN_ALLOWED_PREFIXES.some(p => pathname.startsWith(p)) && searchParams.has("t");
  if (hasToken) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
