import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "项目管理" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { getProductionPermissionContext, getProductionMeta } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { cookies } from "next/headers";
import AdminSettingsClient from "@/components/AdminSettingsClient";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const [meta, access] = await Promise.all([
    getProductionMeta(id),
    session
      ? getProductionPermissionContext(session.userId, session.isAdmin, id)
      : Promise.resolve(null),
  ]);

  const permCtx = access?.permCtx ?? null;
  const isArchived = access?.isArchived ?? false;

  const perms = {
    canRename: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/name", "edit")),
    canChangeAvatar: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/avatar", "edit")),
    canEditDescription: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/description", "edit")),
    canChangeType: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/type", "edit")),
    canChangeLanguage: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "meta/language", "edit")),
    canArchive: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "production", "*", "archival", "create")),
    canDelete: !!permCtx && (permCtx.isAdmin || permCtx.isOwner),
    canImportContacts: !!permCtx && (permCtx.isOwner || (permCtx.isAdmin && permCtx.memberPermissions === null) || await hasGrant(permCtx.userId, id, "member", "*", "imports", "create")),
    canImportScript: !!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "script", "*", "imports", "create")),
    canImportScenes: !!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "dramaturgy", "*", "imports", "create")),
    canManageTags: !!permCtx && (permCtx.isAdmin || await hasGrant(permCtx.userId, id, "member", "*", "roles", "edit")),
  };

  return (
    <AdminSettingsClient
      productionId={id}
      initialMeta={meta ?? { name: "", description: "", avatarUrl: null, type: null, typeLabel: null, language: null }}
      isArchived={isArchived}
      perms={perms}
    />
  );
}
