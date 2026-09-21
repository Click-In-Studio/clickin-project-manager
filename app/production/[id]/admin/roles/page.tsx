import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色管理" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { getPool } from "@/lib/pg";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { listProductionRolesWithPermissions } from "@/lib/perm/role-db";
import { listProductionMembersWithRoles } from "@/lib/perm/member-db";
import { listProductionDepts } from "@/lib/perm/dept-db";
import AdminRolesClient from "@/components/admin/AdminRolesClient";

export default async function RolesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;

  const [canCreate, canRename, canDelete, canAssign, canViewContact] = await Promise.all([
    hasEffectiveGrant(permCtx, id, "role", "*", "*", "create"),
    hasEffectiveGrant(permCtx, id, "role", "*", "meta/name", "edit"),
    hasEffectiveGrant(permCtx, id, "role", "*", "*", "delete"),
    hasEffectiveGrant(permCtx, id, "member", "*", "roles", "edit"),
    hasEffectiveGrant(permCtx, id, "member", "*", "contact", "view"),
  ]);

  const [name, roles, membersRaw, depts, ownerRes] = await Promise.all([
    getProductionName(id),
    listProductionRolesWithPermissions(id),
    listProductionMembersWithRoles(id),
    listProductionDepts(id),
    getPool().query<{ owner_id: string | null; owner_name: string | null }>(
      `SELECT p.owner_id, up.name AS owner_name
       FROM production p LEFT JOIN user_profile up ON up.user_id = p.owner_id
       WHERE p.id = $1`,
      [id],
    ),
  ]);

  // 本页只管角色人事：权限键集不出服务端（权限中心才是键面）；
  // 联系方式按 contact@view 裁剪（人员 picker 搜索用）。
  const members = membersRaw.map(m => ({
    userId: m.userId,
    name: m.name,
    avatarUrl: m.avatarUrl,
    photoUrl: m.photoUrl,
    roles: m.roles,
    tags: m.tags,
    email: canViewContact ? m.email : null,
    phone: canViewContact ? m.phone : null,
    status: m.status,
  }));

  return (
    <AdminRolesClient
      productionId={id}
      productionName={name ?? ""}
      initialRoles={roles.map(r => ({ id: r.id, name: r.name }))}
      members={members}
      depts={depts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, kind: d.kind, memberUserIds: d.memberUserIds }))}
      owner={{
        userId: ownerRes.rows[0]?.owner_id ?? null,
        name: ownerRes.rows[0]?.owner_name ?? null,
      }}
      caps={{ create: canCreate, rename: canRename, remove: canDelete, assign: canAssign }}
    />
  );
}
