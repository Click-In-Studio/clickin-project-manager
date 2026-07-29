import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { consumeEmailOtp, getUserProfile } from "@/lib/db";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";

export async function POST(req: NextRequest) {
  let body: { email?: string; code?: string };
  try {
    body = await req.json() as { email?: string; code?: string };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const code = body.code?.trim();
  if (!email || !code) return Response.json({ error: "missing email or code" }, { status: 400 });

  const userId = await consumeEmailOtp(email, code);
  if (!userId) return Response.json({ error: "invalid or expired code" }, { status: 401 });

  const profile = await getUserProfile(userId);
  const sessionId = createSession({
    userId,
    name: profile?.name ?? email,
    avatarUrl: profile?.avatarUrl ?? null,
    isAdmin: profile?.isAdmin ?? false,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);

  return Response.json({ ok: true });
}
