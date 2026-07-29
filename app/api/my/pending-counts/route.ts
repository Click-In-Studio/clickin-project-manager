/**
 * GET /api/my/pending-counts
 *
 * Returns { notifications, tasks } — sidebar badge counts.
 * Single round-trip so AppShell only needs one fetch.
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { countUnreadNotifications } from "@/lib/inbox-db";
import { countPendingTasksForUser, countUnreadReportsForUser } from "@/lib/event-db";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ notifications: 0, tasks: 0, reports: 0 });

  const [notifications, tasks, reports] = await Promise.all([
    countUnreadNotifications(session.userId),
    countPendingTasksForUser(session.userId),
    countUnreadReportsForUser(session.userId),
  ]);

  return Response.json({ notifications, tasks, reports });
}
