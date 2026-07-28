import type { Metadata } from "next";
export const metadata: Metadata = { title: "项目管理" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { cookies } from "next/headers";
import AdminSettingsClient from "@/components/AdminSettingsClient";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [name, access] = await Promise.all([
    getProductionName(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
  ]);

  const permCtx = access?.permCtx ?? null;
  const isArchived = access?.isArchived ?? false;

  const perms = {
    canRename: !!permCtx && hasPermission("production:rename", permCtx),
    canArchive: !!permCtx && hasPermission("production:archive", permCtx),
    canDelete: !!permCtx && hasPermission("production:delete", permCtx),
    canImportContacts: !!permCtx && hasPermission("contacts:import", permCtx),
    canImportScript: !!permCtx && hasPermission("script:import", permCtx),
    canImportScenes: !!permCtx && hasPermission("dramaturgy:import", permCtx),
  };

  return (
    <AdminSettingsClient
      productionId={id}
      productionName={name ?? ""}
      isArchived={isArchived}
      perms={perms}
    />
  );
}
