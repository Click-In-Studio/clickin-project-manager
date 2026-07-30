import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession, generateOAuthState, OAUTH_STATE_COOKIE } from "@/lib/session";
import { feishuPlatform } from "@/lib/platform/feishu";

const BIND_SOURCE_COOKIE = "bind_source_user_id";

function requestBaseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return NextResponse.redirect(new URL("/login", requestBaseUrl(req)));

  const state = generateOAuthState();
  const baseUrl = requestBaseUrl(req);
  const redirectUri = `${baseUrl}/api/account/bind/feishu/callback`;
  const url = feishuPlatform.generateAuthUrl(state, redirectUri);

  cookieStore.set(OAUTH_STATE_COOKIE, state, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 600 });
  cookieStore.set(BIND_SOURCE_COOKIE, session.userId, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 600 });

  return NextResponse.redirect(url);
}
