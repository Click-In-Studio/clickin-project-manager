/**
 * GET /api/my/notifications/unread-count
 *
 * Returns { count: number } — used by AppShell bell badge.
 * Lightweight single-column query, safe to call on every page load.
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { countUnreadNotifications } from "@/lib/inbox-db";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ count: 0 });
  const count = await countUnreadNotifications(session.userId);
  return Response.json({ count });
}
