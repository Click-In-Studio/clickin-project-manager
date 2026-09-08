import type { Metadata } from "next";
export const metadata: Metadata = { title: "我的项目" };

import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserTier } from "@/lib/plan";
import MyProjectsClient from "@/components/MyProjectsClient";

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


export default async function MyProjectsPage() {
  // 「+ 新建项目」的显隐是用户等级（付费维度），与项目内权限无关：user_plan 无行的
  // 普通注册用户看得到自己参与的项目列表，但没有新建入口。
  const session = getSession(await cookies());
  const tier = session ? await getUserTier(session.userId) : null;

  if (!session) return <MyProjectsClient canCreate={false} currentUserId="" />;
  return <MyProjectsClient canCreate={tier !== null} currentUserId={session.userId} />;
}
