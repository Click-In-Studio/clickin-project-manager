import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "首页" };
import { listProductions } from "@/lib/db";
import { listMyUpcomingCallTimes, listMyPendingTechReqs, listMyFollowedUpcomingEvents, listUnreadFollowedReports } from "@/lib/event-db";
import HomeClient from "@/components/HomeClient";

export default async function Home() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [productions, myCallTimes, myPendingReqs, myFollowedEvents, myUnreadReports] = await Promise.all([
    listProductions({ openId: session.openId, isAdmin: session.isAdmin }),
    listMyUpcomingCallTimes(session.openId),
    listMyPendingTechReqs(session.openId),
    listMyFollowedUpcomingEvents(session.openId),
    listUnreadFollowedReports(session.openId),
  ]);

  return (
    <HomeClient
      productions={productions}
      isAdmin={session.isAdmin}
      currentUser={{ name: session.name, avatarUrl: session.avatarUrl }}
      myCallTimes={myCallTimes}
      myPendingReqs={myPendingReqs}
      myFollowedEvents={myFollowedEvents}
      myUnreadReports={myUnreadReports}
    />
  );
}
