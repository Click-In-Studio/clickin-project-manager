import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色管理" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getPool } from "@/lib/pg";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionRolesWithPermissions,
  listProductionMembersWithRoles,
} from "@/lib/db";
import AdminRolesClient from "@/components/AdminRolesClient";

export default async function RolesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  const [canCreate, canRename, canDelete, canAssign] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "role", "*", "*", "create"),
    bypass || hasGrant(permCtx.userId, id, "role", "*", "meta/name", "edit"),
    bypass || hasGrant(permCtx.userId, id, "role", "*", "*", "delete"),
    bypass || hasGrant(permCtx.userId, id, "member", "*", "roles", "edit"),
  ]);

  const [name, roles, membersRaw, ownerRes] = await Promise.all([
    getProductionName(id),
    listProductionRolesWithPermissions(id),
    listProductionMembersWithRoles(id),
    getPool().query<{ owner_id: string | null; owner_name: string | null }>(
      `SELECT p.owner_id, up.name AS owner_name
       FROM production p LEFT JOIN user_profile up ON up.user_id = p.owner_id
       WHERE p.id = $1`,
      [id],
    ),
  ]);

  // 本页只管角色人事：权限键集不出服务端（权限中心才是键面）。
  const members = membersRaw.map(m => ({
    userId: m.userId,
    name: m.name,
    avatarUrl: m.avatarUrl,
    photoUrl: m.photoUrl,
    roles: m.roles,
    status: m.status,
  }));

  return (
    <AdminRolesClient
      productionId={id}
      productionName={name ?? ""}
      initialRoles={roles.map(r => ({ id: r.id, name: r.name }))}
      members={members}
      owner={{
        userId: ownerRes.rows[0]?.owner_id ?? null,
        name: ownerRes.rows[0]?.owner_name ?? null,
      }}
      caps={{ create: canCreate, rename: canRename, remove: canDelete, assign: canAssign }}
    />
  );
}
