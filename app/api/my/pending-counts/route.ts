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
import { countCueWarningsForProduction } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ notifications: 0, tasks: 0, reports: 0, cueWarnings: 0 });

  const productionId = req.nextUrl.searchParams.get("productionId") ?? undefined;

  const [notifications, tasks, reports, cueWarnings] = await Promise.all([
    countUnreadNotifications(session.userId, productionId),
    countPendingTasksForUser(session.userId, productionId),
    countUnreadReportsForUser(session.userId, productionId),
    productionId ? countCueWarningsForProduction(productionId) : Promise.resolve(0),
  ]);

  return Response.json({ notifications, tasks, reports, cueWarnings });
}
