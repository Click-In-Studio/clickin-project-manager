import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { feishuPlatform } from "@/lib/platform/feishu";
import { createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";

// Feishu in-app JS SDK auth code (not OAuth web flow)
export async function POST(req: NextRequest) {
  const body = await req.json() as { code?: string };
  if (!body.code) return Response.json({ error: "missing code" }, { status: 400 });

  let loginResult;
  try {
    loginResult = await feishuPlatform.performLogin(body.code);
  } catch {
    return Response.json({ error: "Feishu 授权失败" }, { status: 502 });
  }

  const sessionId = createSession({
    userId: loginResult.userId,
    name: loginResult.name,
    avatarUrl: loginResult.avatarUrl,
    isAdmin: loginResult.isAdmin,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
  for (const c of loginResult.extraCookies ?? []) {
    cookieStore.set(c.name, c.value, c.opts as Parameters<typeof cookieStore.set>[2]);
  }

  return Response.json({ ok: true });
}
