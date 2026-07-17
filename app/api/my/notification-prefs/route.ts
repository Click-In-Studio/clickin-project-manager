import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getUserPrefs, setUserPref, NOTIFICATION_CONFIG } from "@/lib/notification-prefs";
import type { NotificationType } from "@/lib/notification-prefs";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const prefs = await getUserPrefs(session.openId);
  return Response.json({ prefs });
}

export async function PATCH(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = (await req.json()) as { type?: string; enabled?: boolean };
  const { type, enabled } = body;

  if (!type || typeof enabled !== "boolean")
    return Response.json({ error: "参数错误" }, { status: 400 });
  if (!(type in NOTIFICATION_CONFIG))
    return Response.json({ error: "未知通知类型" }, { status: 400 });

  await setUserPref(session.openId, type as NotificationType, enabled);
  return Response.json({ ok: true });
}
