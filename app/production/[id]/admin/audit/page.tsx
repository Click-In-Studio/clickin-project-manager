import type { Metadata } from "next";
export const metadata: Metadata = { title: "权限审计" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getProductionName, listProductionMembersWithRoles } from "@/lib/db";
import { listProductionDepts } from "@/lib/dept-db";
import { listGrantLedger } from "@/lib/grant-audit-db";
import AdminAuditClient from "@/components/AdminAuditClient";

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  const [canRevoke, canViewOnly, canViewContact] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "production", "*", "grants", "delete"),
    bypass || hasGrant(permCtx.userId, id, "production", "*", "grants", "view"),
    bypass || hasGrant(permCtx.userId, id, "member", "*", "contact", "view"),
  ]);
  const canView = canRevoke || canViewOnly;
  if (!canView) redirect(`/production/${id}/admin`);

  const [name, initial, members, depts] = await Promise.all([
    getProductionName(id),
    listGrantLedger(id, { limit: 100 }),
    listProductionMembersWithRoles(id),
    listProductionDepts(id),
  ]);

  return (
    <AdminAuditClient
      productionId={id}
      productionName={name ?? ""}
      initialRows={initial.rows}
      initialTotal={initial.total}
      members={members.map(m => ({
        userId: m.userId, name: m.name, avatarUrl: m.avatarUrl, photoUrl: m.photoUrl,
        roles: m.roles, tags: m.tags,
        email: canViewContact ? m.email : null,
        phone: canViewContact ? m.phone : null,
        status: m.status,
      }))}
      depts={depts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, kind: d.kind, memberUserIds: d.memberUserIds }))}
      canRevoke={canRevoke}
    />
  );
}
