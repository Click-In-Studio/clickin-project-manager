import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyBindingToken, signConflictToken } from "@/lib/platform/email/email-tokens";
import { bindPlatformIdentity, getUserProfile } from "@/lib/db";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";

function redirectBase(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const base = redirectBase(req);

  if (!token) return NextResponse.redirect(new URL("/account?bind_error=invalid", base));

  const data = verifyBindingToken(token);
  if (!data) return NextResponse.redirect(new URL("/account?bind_error=expired", base));

  const { sourceUserId, email } = data;
  const bindResult = await bindPlatformIdentity(sourceUserId, "email", email);

  if (bindResult.result === "conflict") {
    const mergeToken = signConflictToken(sourceUserId, bindResult.existingUserId);
    const url = new URL("/account", base);
    url.searchParams.set("pending_merge", mergeToken);
    url.searchParams.set("merge_platform", "email");
    // Ensure user is logged in (refresh session for sourceUserId)
    const profile = await getUserProfile(sourceUserId);
    const sessionId = createSession({
      userId: sourceUserId,
      name: profile?.name ?? email,
      avatarUrl: profile?.avatarUrl ?? null,
      isAdmin: profile?.isAdmin ?? false,
    });
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
    return NextResponse.redirect(url);
  }

  // Success — ensure user is logged in
  const profile = await getUserProfile(sourceUserId);
  const sessionId = createSession({
    userId: sourceUserId,
    name: profile?.name ?? email,
    avatarUrl: profile?.avatarUrl ?? null,
    isAdmin: profile?.isAdmin ?? false,
  });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
  return NextResponse.redirect(new URL("/account?bound=email", base));
}
