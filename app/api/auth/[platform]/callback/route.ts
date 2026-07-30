import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPersonalChannel } from "@/lib/platform/registry";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS, OAUTH_STATE_COOKIE } from "@/lib/session";

type Params = { params: Promise<{ platform: string }> };

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

  let loginResult;
  try {
    loginResult = await ch.performLogin(code);
  } catch (e) {
    console.error(`[auth/${platform}/callback]`, e);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    const loginUrl = new URL("/login?error=auth_failed", `${proto}://${host}`);
    return NextResponse.redirect(loginUrl);
  }

  const sessionId = createSession({
    userId: loginResult.userId,
    name: loginResult.name,
    avatarUrl: loginResult.avatarUrl,
    isAdmin: loginResult.isAdmin,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
  cookieStore.delete(OAUTH_STATE_COOKIE);

  for (const c of loginResult.extraCookies ?? []) {
    cookieStore.set(c.name, c.value, c.opts as Parameters<typeof cookieStore.set>[2]);
  }

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return NextResponse.redirect(new URL("/", `${proto}://${host}`));
}
