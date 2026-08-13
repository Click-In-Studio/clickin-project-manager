import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "通知公告" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionPermissionContext, listAnnouncements } from "@/lib/db";
import { } from "@/lib/permissions";
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
      canCreate={!!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "announcement", "*", "*", "create"))}
      canEdit={!!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "announcement", "*", "*", "edit"))}
      canDelete={!!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "announcement", "*", "*", "delete"))}
    />
  );
}
