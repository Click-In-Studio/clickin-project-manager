import type { Metadata } from "next";
export const metadata: Metadata = { title: "成员与部门" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/perm/admin-guard";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
  listProductionRolesWithPermissions,
  listMemberTags,
} from "@/lib/db";
import { listProductionDepts } from "@/lib/perm/dept-db";
import { getSeatUsage } from "@/lib/account/plan";
import AdminOrganizationClient from "@/components/admin/AdminOrganizationClient";

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;

  // 可见门与可改门分离；SSR props 按门裁剪，无权数据不出服务端。
  const [canViewContact, canEditMember, canInvite, canRemove, canDeptStructure, canDeptMembers, canDeptPoc] =
    await Promise.all([
      hasEffectiveGrant(permCtx, id, "member", "*", "contact", "view"),
      hasEffectiveGrant(permCtx, id, "member", "*", "roles", "edit"),
      hasEffectiveGrant(permCtx, id, "member", "*", "*", "create"),
      hasEffectiveGrant(permCtx, id, "member", "*", "*", "delete"),
      hasEffectiveGrant(permCtx, id, "dept", "*", "*", "create"),
      hasEffectiveGrant(permCtx, id, "dept", "*", "members", "create"),
      hasEffectiveGrant(permCtx, id, "dept", "*", "poc", "create"),
    ]);

  const [name, membersRaw, depts, tags, roles, seats] = await Promise.all([
    getProductionName(id),
    listProductionMembersWithRoles(id),
    listProductionDepts(id),
    listMemberTags(id),
    listProductionRolesWithPermissions(id),
    getSeatUsage(id),
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
    statusSource: m.statusSource,
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
      // 席位上限（#313）：占用数客户端按 members 自算（确认离组后实时掉），只传 limit。
      seatLimit={seats.limit}
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
