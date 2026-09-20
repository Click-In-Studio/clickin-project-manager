import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession, generateOAuthState, OAUTH_STATE_COOKIE } from "@/lib/account/session";
import { feishuPlatform } from "@/lib/platform/feishu";
import { requestOrigin } from "@/lib/account/request-origin";

const BIND_SOURCE_COOKIE = "bind_source_user_id";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return NextResponse.redirect(new URL("/login", requestOrigin(req)));

  const state = generateOAuthState();
  const baseUrl = requestOrigin(req);
  const redirectUri = `${baseUrl}/api/account/bind/feishu/callback`;
  const url = feishuPlatform.generateAuthUrl(state, redirectUri);

  cookieStore.set(OAUTH_STATE_COOKIE, state, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 600 });
  cookieStore.set(BIND_SOURCE_COOKIE, session.userId, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 600 });

  return NextResponse.redirect(url);
}
