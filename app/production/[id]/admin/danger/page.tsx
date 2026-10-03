import type { Metadata } from "next";
export const metadata: Metadata = { title: "危险操作" };

import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getPool } from "@/lib/pg";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { listProductionMembersWithRoles } from "@/lib/perm/member-db";
import PageHeader from "@/components/ui/PageHeader";
import { listProductionDepts } from "@/lib/perm/dept-db";
import TransferOwnerCard from "@/components/admin/TransferOwnerCard";
import AdminDangerSection from "@/components/admin/AdminDangerSection";
import styles from "@/components/admin/admin-danger.module.css";

export default async function DangerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;

  const canArchive = await hasEffectiveGrant(permCtx, id, "production", "*", "archival", "create");
  const canDelete = permCtx.isAdmin || permCtx.isOwner;
  const canTransfer = permCtx.isAdmin || permCtx.isOwner;
  if (!canArchive && !canDelete && !canTransfer) redirect(`/production/${id}/admin`);

  const canViewContact = await hasEffectiveGrant(permCtx, id, "member", "*", "contact", "view");
  const [name, ownerRes, members, depts] = await Promise.all([
    getProductionName(id),
    getPool().query<{ owner_id: string | null; owner_name: string | null }>(
      `SELECT p.owner_id, up.name AS owner_name
       FROM production p LEFT JOIN user_profile up ON up.user_id = p.owner_id
       WHERE p.id = $1`,
      [id],
    ),
    canTransfer ? listProductionMembersWithRoles(id) : Promise.resolve([]),
    canTransfer ? listProductionDepts(id) : Promise.resolve([]),
  ]);

  return (
    <div className={styles.page}>
      <Link href={`/production/${id}`} className={styles.mobileBack}>
        <span aria-hidden="true">←</span>
        返回项目
      </Link>
      <PageHeader eyebrow={name ?? ""} title="危险操作" side="stage" />
      {canTransfer && (
        <TransferOwnerCard
          productionId={id}
          currentOwnerName={ownerRes.rows[0]?.owner_name ?? null}
          ownerId={ownerRes.rows[0]?.owner_id ?? null}
          members={members.map(m => ({
            userId: m.userId, name: m.name, avatarUrl: m.avatarUrl, photoUrl: m.photoUrl,
            roles: m.roles, tags: m.tags,
            email: canViewContact ? m.email : null,
            phone: canViewContact ? m.phone : null,
            status: m.status,
          }))}
          depts={depts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, kind: d.kind, memberUserIds: d.memberUserIds }))}
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
