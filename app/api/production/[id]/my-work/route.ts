import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listAnnouncements, listMilestones, countCueWarningsForProduction } from "@/lib/db";
import {
  listMyUpcomingCallTimes,
  listMyPendingTechReqs,
  listMyPocAwaitingReqs,
  listUnreadFollowedReports,
} from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [callTimes, pendingReqs, awaitingReqs, unreadReports, announcements, milestones, cueWarningCount] = await Promise.all([
    listMyUpcomingCallTimes(session.userId, productionId),
    listMyPendingTechReqs(session.userId, productionId),
    listMyPocAwaitingReqs(session.userId, productionId),
    listUnreadFollowedReports(session.userId, productionId),
    listAnnouncements(productionId),
    listMilestones(productionId),
    countCueWarningsForProduction(productionId, session.userId, session.isAdmin),
  ]);

  const pinnedAnnouncement = announcements.find(a => a.isPinned) ?? announcements[0] ?? null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nextMilestone = milestones.find(m => new Date(m.endDate) >= today) ?? null;

  return NextResponse.json({
    callTimes, pendingReqs, awaitingReqs, unreadReports,
    isArchived: access.isArchived,
    pinnedAnnouncement,
    nextMilestone,
    cueWarningCount,
  });
}
