import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listMyTechReqsFull } from "@/lib/event-db";
import MyTasksClient from "@/components/MyTasksClient";

export const metadata: Metadata = { title: "我的任务" };

export default async function MyTasksPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const tasks = await listMyTechReqsFull(session.userId);
  return <MyTasksClient initialTasks={tasks} />;
}
