/**
 * GET /api/my/notifications
 *
 * Query params:
 *   productionId  – filter to a specific production
 *   filter        – "all" | "pending" | "read"  (default: "all")
 *   before        – ISO timestamp cursor for pagination
 *   limit         – number of results (default 40, max 100)
 *
 * PATCH /api/my/notifications
 *   body: { ids?: string[] }  – mark as read; omit ids to mark all read
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  listUserNotifications, markAllNotificationsRead,
  markNotificationRead, autoCompleteDeadNotifications,
} from "@/lib/inbox-db";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const url = new URL(req.url);
  const productionId = url.searchParams.get("productionId") ?? undefined;
  const filterRaw = url.searchParams.get("filter") ?? "all";
  const filter = (["all", "pending", "read"].includes(filterRaw)
    ? filterRaw
    : "all") as "all" | "pending" | "read";
  const before = url.searchParams.get("before") ?? undefined;
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "40", 10);
  const limit = Math.min(isNaN(limitRaw) ? 40 : limitRaw, 100);

  // Clean up notifications whose entity was deleted (fire-and-forget, non-blocking)
  autoCompleteDeadNotifications(session.userId).catch(() => {});

  const notifications = await listUserNotifications(session.userId, {
    productionId,
    filter,
    limit,
    before,
  });

  return Response.json({ notifications });
}

export async function PATCH(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    ids?: string[];
    productionId?: string;
  };

  if (body.ids && Array.isArray(body.ids)) {
    await Promise.all(
      body.ids.map((id) => markNotificationRead(id, session.userId)),
    );
  } else {
    await markAllNotificationsRead(session.userId, body.productionId);
  }

  return Response.json({ ok: true });
}
