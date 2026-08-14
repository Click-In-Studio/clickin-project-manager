import type { Metadata } from "next";
export const metadata: Metadata = { title: "危险操作" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getPool } from "@/lib/pg";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
} from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import TransferOwnerCard from "@/components/TransferOwnerCard";
import AdminDangerSection from "@/components/AdminDangerSection";

export default async function DangerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  const canArchive = bypass || await hasGrant(permCtx.userId, id, "production", "*", "archival", "create");
  const canDelete = permCtx.isAdmin || permCtx.isOwner;
  const canTransfer = permCtx.isAdmin || permCtx.isOwner;
  if (!canArchive && !canDelete && !canTransfer) redirect(`/production/${id}/admin`);

  const [name, ownerRes, members] = await Promise.all([
    getProductionName(id),
    getPool().query<{ owner_id: string | null; owner_name: string | null }>(
      `SELECT p.owner_id, up.name AS owner_name
       FROM production p LEFT JOIN user_profile up ON up.user_id = p.owner_id
       WHERE p.id = $1`,
      [id],
    ),
    canTransfer ? listProductionMembersWithRoles(id) : Promise.resolve([]),
  ]);

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={name ?? ""} title="危险操作" side="stage" />
      {canTransfer && (
        <TransferOwnerCard
          productionId={id}
          currentOwnerName={ownerRes.rows[0]?.owner_name ?? null}
          ownerId={ownerRes.rows[0]?.owner_id ?? null}
          members={members.map(m => ({ userId: m.userId, name: m.name }))}
        />
      )}
      <AdminDangerSection
        productionId={id}
        productionName={name ?? ""}
        isArchived={access.isArchived}
        canArchive={canArchive}
        canDelete={canDelete}
      />
    </div>
  );
}
