import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSession, createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";
import { verifyConflictToken } from "@/lib/platform/email/email-tokens";
import { mergeAccounts, getUserProfile } from "@/lib/db";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { token?: string; keepUserId?: string };
  if (!body.token || !body.keepUserId) {
    return Response.json({ error: "missing token or keepUserId" }, { status: 400 });
  }

  const data = verifyConflictToken(body.token);
  if (!data) return Response.json({ error: "invalid or expired token" }, { status: 400 });

  const { userIdA, userIdB } = data;

  // Session must belong to one of the two conflicting accounts
  if (session.userId !== userIdA && session.userId !== userIdB) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // keepUserId must be one of the two accounts
  if (body.keepUserId !== userIdA && body.keepUserId !== userIdB) {
    return Response.json({ error: "invalid keepUserId" }, { status: 400 });
  }

  const deleteUserId = body.keepUserId === userIdA ? userIdB : userIdA;

  try {
    await mergeAccounts(body.keepUserId, deleteUserId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "merge failed";
    return Response.json({ error: msg }, { status: 409 });
  }

  // If the session user was deleted, issue a new session for the kept account
  if (session.userId === deleteUserId) {
    const profile = await getUserProfile(body.keepUserId);
    const newSessionId = createSession({
      userId: body.keepUserId,
      name: profile?.name ?? "用户",
      avatarUrl: profile?.avatarUrl ?? null,
      isAdmin: profile?.isAdmin ?? false,
    });
    cookieStore.set(SESSION_COOKIE, newSessionId, SESSION_COOKIE_OPTS);
  }

  return Response.json({ ok: true });
}
