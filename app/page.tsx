import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";

export const metadata: Metadata = { title: "首页" };
import { listProductions } from "@/lib/production/production-db";
import { listUpcomingMilestonesForUser } from "@/lib/ops/milestone-db";
import { countCueWarningsForUser } from "@/lib/ops/cue-db";
import { listMyUpcomingCallTimes, listMyPendingTechReqs, listMyPocAwaitingReqs, listUnreadFollowedReports } from "@/lib/ops/event-db";
import HomeClient from "@/components/ops/HomeClient";

export default async function Home() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore)!;

  const [productions, myCallTimes, myPendingReqs, myAwaitingReqs, myUnreadReports, upcomingMilestones, totalCueWarnings] = await Promise.all([
    listProductions({ userId: session.userId, isAdmin: session.isAdmin }),
    listMyUpcomingCallTimes(session.userId),
    listMyPendingTechReqs(session.userId),
    listMyPocAwaitingReqs(session.userId),
    listUnreadFollowedReports(session.userId),
    listUpcomingMilestonesForUser(session.userId, session.isAdmin),
    countCueWarningsForUser(session.userId, session.isAdmin),
  ]);

  return (
    <HomeClient
      productions={productions}
      myCallTimes={myCallTimes}
      myPendingReqs={myPendingReqs}
      myAwaitingReqs={myAwaitingReqs}
      myUnreadReports={myUnreadReports}
      upcomingMilestones={upcomingMilestones}
      totalCueWarnings={totalCueWarnings}
    />
  );
}
