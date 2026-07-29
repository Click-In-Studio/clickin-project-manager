import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPersonalChannel } from "@/lib/platform/registry";
import { generateOAuthState, OAUTH_STATE_COOKIE } from "@/lib/session";

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

  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 600,
  });

  return NextResponse.redirect(url);
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

  const baseUrl = requestBaseUrl(req);
  try {
    await ch.initiateLogin(body, { baseUrl });
  } catch (e) {
    console.error(`[auth/${platform}/initiate]`, e);
    return Response.json({ error: "failed to initiate login" }, { status: 502 });
  }

  return Response.json({ sent: true });
}
