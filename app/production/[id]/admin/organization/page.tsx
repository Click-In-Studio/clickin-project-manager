import type { Metadata } from "next";
export const metadata: Metadata = { title: "成员与部门" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
  listProductionRolesWithPermissions,
  listMemberTags,
} from "@/lib/db";
import { listProductionDepts } from "@/lib/dept-db";
import AdminOrganizationClient from "@/components/AdminOrganizationClient";

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  // 可见门与可改门分离；SSR props 按门裁剪，无权数据不出服务端。
  const [canViewContact, canEditMember, canInvite, canRemove, canDeptStructure, canDeptMembers, canDeptPoc] =
    await Promise.all([
      bypass || hasGrant(permCtx.userId, id, "member", "*", "contact", "view"),
      bypass || hasGrant(permCtx.userId, id, "member", "*", "roles", "edit"),
      bypass || hasGrant(permCtx.userId, id, "member", "*", "*", "create"),
      bypass || hasGrant(permCtx.userId, id, "member", "*", "*", "delete"),
      bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "*", "create"),
      bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "members", "create"),
      bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "poc", "create"),
    ]);

  const [name, membersRaw, depts, tags, roles] = await Promise.all([
    getProductionName(id),
    listProductionMembersWithRoles(id),
    listProductionDepts(id),
    listMemberTags(id),
    listProductionRolesWithPermissions(id),
  ]);

  const members = membersRaw.map(m => ({
    userId: m.userId,
    name: m.name,
    avatarUrl: m.avatarUrl,
    email: canViewContact ? m.email : null,
    phone: canViewContact ? m.phone : null,
    roles: m.roles,
    tags: m.tags,
    photoUrl: m.photoUrl,
    supervisorId: m.supervisorId,
    supervisorName: m.supervisorName,
    status: m.status,
  }));

  return (
    <AdminOrganizationClient
      productionId={id}
      productionName={name ?? ""}
      initialMembers={members}
      initialDepts={depts.map(d => ({
        id: d.id,
        name: d.name,
        parentId: d.parentId,
        kind: d.kind,
        displayOrder: d.displayOrder,
        memberUserIds: d.memberUserIds,
        pocUserIds: d.pocUserIds,
      }))}
      tags={tags}
      roleNames={roles.map(r => r.name)}
      caps={{
        viewContact: canViewContact,
        editMember: canEditMember,
        invite: canInvite,
        remove: canRemove,
        deptStructure: canDeptStructure,
        deptMembers: canDeptMembers,
        deptPoc: canDeptPoc,
      }}
      currentUserId={session.userId}
    />
  );
}
