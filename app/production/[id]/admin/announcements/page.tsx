import type { Metadata } from "next";
export const metadata: Metadata = { title: "通知公告" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionPermissionContext, listAnnouncements } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { cookies } from "next/headers";
import AdminAnnouncementsClient from "@/components/AdminAnnouncementsClient";

export default async function AnnouncementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [announcements, access] = await Promise.all([
    listAnnouncements(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
  ]);

  const permCtx = access?.permCtx ?? null;

  return (
    <AdminAnnouncementsClient
      productionId={id}
      initialAnnouncements={announcements.map(a => ({
        id: a.id,
        title: a.title,
        content: a.content,
        isPinned: a.isPinned,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }))}
      canCreate={!!permCtx && hasPermission("announcement:create", permCtx)}
      canEdit={!!permCtx && hasPermission("announcement:edit", permCtx)}
      canDelete={!!permCtx && hasPermission("announcement:delete", permCtx)}
    />
  );
}
