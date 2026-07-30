import type { Metadata } from "next";
export const metadata: Metadata = { title: "项目公告" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listAnnouncements, getUserAnnouncementReadIds, getProductionName } from "@/lib/db";
import ProductionAnnouncementsClient from "@/components/ProductionAnnouncementsClient";

export default async function ProductionAnnouncementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) notFound();

  const [announcements, readIds, productionName] = await Promise.all([
    listAnnouncements(id),
    getUserAnnouncementReadIds(id, session.userId),
    getProductionName(id),
  ]);

  const sorted = [...announcements].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <ProductionAnnouncementsClient
      productionId={id}
      productionName={productionName ?? ""}
      initialAnnouncements={sorted.map(a => ({
        id: a.id,
        title: a.title,
        content: a.content,
        isPinned: a.isPinned,
        createdAt: a.createdAt,
      }))}
      initialReadIds={readIds}
    />
  );
}
