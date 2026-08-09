import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listMyProductionsWithRoles } from "@/lib/db";
import MyNotificationsClient from "@/components/MyNotificationsClient";

export const metadata: Metadata = { title: "通知提醒" };

export default async function NotificationsPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const rawProductions = await listMyProductionsWithRoles(session.userId, session.isAdmin, []);
  const productions = rawProductions.map((p) => ({ id: p.id, name: p.name }));

  return <MyNotificationsClient productions={productions} />;
}
