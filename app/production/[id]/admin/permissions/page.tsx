import type { Metadata } from "next";
export const metadata: Metadata = { title: "权限中心" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/admin-guard";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionRolesWithPermissions,
  listProductionMembersWithRoles,
  getAllPermissionOverrides,
} from "@/lib/db";
import { listProductionDepts } from "@/lib/dept-db";
import { listDeptPermissionRows, getPermissionVocabulary } from "@/lib/perm-center-db";
import AdminPermissionCenterClient from "@/components/AdminPermissionCenterClient";

export default async function PermissionCenterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  // 三 tab 各自 view/edit 双门；无 view 门的 tab 数据不出服务端。
  const [deptEdit, deptViewOnly, roleEdit, overrideEdit] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "grants", "edit"),
    bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "grants", "view"),
    bypass || hasGrant(permCtx.userId, id, "role", "*", "grants", "edit"),
    bypass || hasGrant(permCtx.userId, id, "member", "*", "overrides", "edit"),
  ]);
  const deptView = deptEdit || deptViewOnly;
  // 角色/override 现无独立 view 节点：读随写门（宁严勿松）。
  const roleView = roleEdit;
  const overrideView = overrideEdit;

  if (!deptView && !roleView && !overrideView) redirect(`/production/${id}/admin`);

  const [name, depts, deptRows, roles, membersRaw, overrides, vocabulary] = await Promise.all([
    getProductionName(id),
    deptView ? listProductionDepts(id) : Promise.resolve([]),
    deptView ? listDeptPermissionRows(id) : Promise.resolve({}),
    roleView ? listProductionRolesWithPermissions(id) : Promise.resolve([]),
    overrideView ? listProductionMembersWithRoles(id) : Promise.resolve([]),
    overrideView ? getAllPermissionOverrides(id) : Promise.resolve({}),
    getPermissionVocabulary(id),
  ]);

  return (
    <AdminPermissionCenterClient
      productionId={id}
      productionName={name ?? ""}
      depts={depts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, kind: d.kind, displayOrder: d.displayOrder }))}
      initialDeptRows={deptRows}
      initialRoles={roles.map(r => ({ id: r.id, name: r.name, permissions: r.permissions }))}
      members={membersRaw.map(m => ({ userId: m.userId, name: m.name, roles: m.roles, status: m.status }))}
      initialOverrides={overrides}
      vocabulary={vocabulary}
      caps={{
        deptView, deptEdit,
        roleView, roleEdit,
        overrideView, overrideEdit,
        rootOperation: bypass,
      }}
    />
  );
}
