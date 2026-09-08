import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "首页" };
import { listProductions, listUpcomingMilestonesForUser, countCueWarningsForUser } from "@/lib/db";
import { listMyUpcomingCallTimes, listMyPendingTechReqs, listMyPocAwaitingReqs, listMyFollowedUpcomingEvents, listUnreadFollowedReports } from "@/lib/event-db";
import HomeClient from "@/components/HomeClient";

// #416 切页零往返：30 秒内切回本页直接命中 client router cache，不打服务端。
// 承 #258 的归因（切页耗时 90%+ 在网络往返，服务端仅 20–32ms）。
//
// 开这个开关的前提，是**本页自己能触发的写操作全部已失效缓存**——否则用户在本页写完
// 切走再切回来，组件会从写之前的 payload 重新播种，自己的写被打回。本页闭包内的写点
// 已全部走 lib/write-refresh，由 tests/stale-time-whitelist.test.tsx 持续把关：往闭包
// 里塞裸 fetch 写点，那条测试会红。
//
// 别处改的数据晚至多 30 秒是本开关明知接受的代价（见 #416）。
export const unstable_dynamicStaleTime = 30;


export default async function Home() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore)!;

  const [productions, myCallTimes, myPendingReqs, myAwaitingReqs, myFollowedEvents, myUnreadReports, upcomingMilestones, totalCueWarnings] = await Promise.all([
    listProductions({ userId: session.userId, isAdmin: session.isAdmin }),
    listMyUpcomingCallTimes(session.userId),
    listMyPendingTechReqs(session.userId),
    listMyPocAwaitingReqs(session.userId),
    listMyFollowedUpcomingEvents(session.userId),
    listUnreadFollowedReports(session.userId),
    listUpcomingMilestonesForUser(session.userId, session.isAdmin),
    countCueWarningsForUser(session.userId, session.isAdmin),
  ]);

  return (
    <HomeClient
      productions={productions}
      isAdmin={session.isAdmin}
      myCallTimes={myCallTimes}
      myPendingReqs={myPendingReqs}
      myAwaitingReqs={myAwaitingReqs}
      myFollowedEvents={myFollowedEvents}
      myUnreadReports={myUnreadReports}
      upcomingMilestones={upcomingMilestones}
      totalCueWarnings={totalCueWarnings}
    />
  );
}
