import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildOAuthUrl } from "@/lib/feishu-auth";
import { generateOAuthState, OAUTH_STATE_COOKIE } from "@/lib/session";

function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const state = generateOAuthState();
  const origin = requestOrigin(req);
  const url = buildOAuthUrl(state, `${origin}/api/oath-callback`);

  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 600,
  });

  return NextResponse.redirect(url);
}
