import type { Metadata } from "next";
export const metadata: Metadata = { title: "数据迁移" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import AdminMigrationSection from "@/components/AdminMigrationSection";

export default async function MigrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  const [canImportContacts, canImportScript, canImportScenes] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "member", "*", "imports", "create"),
    bypass || hasGrant(permCtx.userId, id, "script", "*", "imports", "create"),
    bypass || hasGrant(permCtx.userId, id, "dramaturgy", "*", "imports", "create"),
  ]);
  if (!canImportContacts && !canImportScript && !canImportScenes) redirect(`/production/${id}/admin`);

  const name = await getProductionName(id);

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={name ?? ""} title="数据迁移" side="stage" />
      <AdminMigrationSection
        productionId={id}
        canImportContacts={canImportContacts}
        canImportScript={canImportScript}
        canImportScenes={canImportScenes}
      />
    </div>
  );
}
