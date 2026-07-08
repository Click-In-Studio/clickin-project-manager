import { type NextRequest, NextResponse } from "next/server";
import { getSession, createSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return Response.json({ error: "仅开发环境可用" }, { status: 403 });
  }

  const session = getSession(req.cookies);
  if (!session) {
    return Response.json({ error: "未登录，请先完成飞书登录" }, { status: 401 });
  }

  const newToken = createSession({ ...session, isAdmin: true });

  const res = NextResponse.json({ ok: true, openId: session.openId, name: session.name });
  res.cookies.set(SESSION_COOKIE, newToken, SESSION_COOKIE_OPTS);
  return res;
}
