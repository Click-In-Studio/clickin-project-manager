import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "人员" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
} from "@/lib/db";
import ContactsClient from "@/components/ContactsClient";

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


export default async function ContactsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "member", "*", "meta", "view"))) redirect(`/unauthorized?resource=node%3Amember%2F*%2Fmeta%40view&id=${id}`);

  const [name, members] = await Promise.all([
    getProductionName(id),
    listProductionMembersWithRoles(id),
  ]);
  if (!name) notFound();

  return <ContactsClient initialMembers={members} />;
}
