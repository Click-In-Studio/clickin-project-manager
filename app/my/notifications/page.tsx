import type { Metadata } from "next";
export const metadata: Metadata = { title: "通知设置" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getUserPrefs } from "@/lib/notification-prefs";
import NotificationsClient from "@/components/NotificationsClient";

export default async function NotificationsPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const prefs = await getUserPrefs(session.userId);

  return <NotificationsClient prefs={prefs} />;
}
