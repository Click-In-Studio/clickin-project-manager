import type { Metadata } from "next";
export const metadata: Metadata = { title: "公告与风险提醒" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listAnnouncementsForUser, listCueWarningsForUser, getUserAllReadAnnouncementIds } from "@/lib/db";
import AnnouncementsClient from "@/components/AnnouncementsClient";

export default async function AnnouncementsPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [announcements, cueWarnings, readIds] = await Promise.all([
    listAnnouncementsForUser(session.userId, session.isAdmin),
    listCueWarningsForUser(session.userId, session.isAdmin),
    getUserAllReadAnnouncementIds(session.userId),
  ]);

  return <AnnouncementsClient announcements={announcements} cueWarnings={cueWarnings} initialReadIds={readIds} />;
}
