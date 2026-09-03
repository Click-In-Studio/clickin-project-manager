import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import {
  getProductionName,
  getProductionPermissionContext,
  getUserAnnouncementReadIds,
  listAnnouncements,
} from "@/lib/db";
import ProductionNotificationsHub from "@/components/ProductionNotificationsHub";

export const metadata: Metadata = { title: "我的通知" };

export default async function NotificationsModulePage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) notFound();

  const [name, announcements, readIds] = await Promise.all([
    getProductionName(id),
    listAnnouncements(id),
    getUserAnnouncementReadIds(id, session.userId),
  ]);
  if (!name) notFound();

  const sorted = [...announcements].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <ProductionNotificationsHub
      productionId={id}
      productionName={name}
      announcements={sorted.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        isPinned: item.isPinned,
        createdAt: item.createdAt,
      }))}
      announcementReadIds={readIds}
    />
  );
}
