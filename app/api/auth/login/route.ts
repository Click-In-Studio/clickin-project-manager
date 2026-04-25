import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildOAuthUrl } from "@/lib/feishu-auth";
import { generateOAuthState, OAUTH_STATE_COOKIE } from "@/lib/session";

export async function GET() {
  const state = generateOAuthState();
  const url = buildOAuthUrl(state);

  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 600,
  });

  return NextResponse.redirect(url);
}
