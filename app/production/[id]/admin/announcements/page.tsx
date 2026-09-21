import type { Metadata } from "next";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
export const metadata: Metadata = { title: "通知公告" };

import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { listAnnouncements } from "@/lib/notify/announcement-db";
import { getSession } from "@/lib/account/session";
import { cookies } from "next/headers";
import AdminAnnouncementsClient from "@/components/admin/AdminAnnouncementsClient";

function countRecent(createdAts: string[]): number {
  const cutoff = Date.now() - 30 * 86400_000;
  return createdAts.filter(iso => new Date(iso).getTime() > cutoff).length;
}

export default async function AnnouncementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [announcements, name, access] = await Promise.all([
    listAnnouncements(id),
    getProductionName(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
  ]);

  const permCtx = access?.permCtx ?? null;

  return (
    <AdminAnnouncementsClient
      productionId={id}
      productionName={name ?? ""}
      recent30Count={countRecent(announcements.map(a => a.createdAt))}
      initialAnnouncements={announcements.map(a => ({
        id: a.id,
        title: a.title,
        content: a.content,
        isPinned: a.isPinned,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }))}
      canCreate={!!permCtx && await hasEffectiveGrant(permCtx, id, "announcement", "*", "*", "create")}
      canEdit={!!permCtx && await hasEffectiveGrant(permCtx, id, "announcement", "*", "*", "edit")}
      canDelete={!!permCtx && await hasEffectiveGrant(permCtx, id, "announcement", "*", "*", "delete")}
    />
  );
}
