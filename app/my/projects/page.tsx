import type { Metadata } from "next";
export const metadata: Metadata = { title: "我的项目" };

import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserTier } from "@/lib/plan";
import MyProjectsClient from "@/components/MyProjectsClient";

export default async function MyProjectsPage() {
  // 「+ 新建项目」的显隐是用户等级（付费维度），与项目内权限无关：user_plan 无行的
  // 普通注册用户看得到自己参与的项目列表，但没有新建入口。
  const session = getSession(await cookies());
  const tier = session ? await getUserTier(session.userId) : null;

  return <MyProjectsClient canCreate={tier !== null} />;
}
