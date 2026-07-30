import { cookies } from "next/headers";
import { getSession, createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";
import { getUserProfile } from "@/lib/db";

export async function POST() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const profile = await getUserProfile(session.userId);
  if (!profile) return Response.json({ error: "用户不存在" }, { status: 404 });

  const newSession = createSession({
    userId: session.userId,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    isAdmin: profile.isAdmin,
  });

  cookieStore.set(SESSION_COOKIE, newSession, SESSION_COOKIE_OPTS);
  return Response.json({ ok: true });
}
