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
import { findProducers } from "@/lib/approval-routing";
import {
  listResourceApprovers, listDelegableResourceTypes, NON_DELEGABLE_RESOURCE_TYPES,
} from "@/lib/resource-approver-db";
import { listDeptPermissionView, getPermissionVocabulary, type DeptPermissionView } from "@/lib/perm-center-db";
import AdminPermissionCenterClient from "@/components/AdminPermissionCenterClient";
import { productionFeatureAllowed } from "@/lib/plan";

export default async function PermissionCenterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  // 项目档位（付费维度）：菜单里已按 advancedPerms 隐藏本项，URL 直达也不放行——
  // 否则页面看着能用、一保存撞 API 的 403。与权限维度无关，故排在权限判定之前。
  if (!(await productionFeatureAllowed(id, "advancedPerms"))) redirect(`/production/${id}/admin`);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;
  const bypass = permCtx.isAdmin || permCtx.isOwner;

  // 四 tab 各自 view/edit 双门；无 view 门的 tab 数据不出服务端。
  const [deptEdit, deptViewOnly, roleEdit, overrideEdit, canViewContact, isProducer, approverGrantEdit, approverGrantView] = await Promise.all([
    bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "grants", "edit"),
    bypass || hasGrant(permCtx.userId, id, "org_dept", "*", "grants", "view"),
    bypass || hasGrant(permCtx.userId, id, "role", "*", "grants", "edit"),
    bypass || hasGrant(permCtx.userId, id, "member", "*", "overrides", "edit"),
    bypass || hasGrant(permCtx.userId, id, "member", "*", "contact", "view"),
    findProducers(id).then(ids => ids.includes(permCtx.userId)),
    bypass || hasGrant(permCtx.userId, id, "production", "*", "grants", "edit"),
    bypass || hasGrant(permCtx.userId, id, "production", "*", "grants", "view"),
  ]);
  const deptView = deptEdit || deptViewOnly;
  // 角色/override 现无独立 view 节点：读随写门（宁严勿松）。
  const roleView = roleEdit;
  const overrideView = overrideEdit;
  // 资源审批人（#262）：门与 API 同一份（制作人显式在内——委派本来就是制作人要做的事）。
  const approverEdit = approverGrantEdit || isProducer;
  const approverView = approverEdit || approverGrantView;

  if (!deptView && !roleView && !overrideView && !approverView) redirect(`/production/${id}/admin`);

  const [name, depts, deptRows, roles, membersRaw, overrides, vocabulary, approvers, delegableTypes] = await Promise.all([
    getProductionName(id),
    deptView ? listProductionDepts(id) : Promise.resolve([]),
    // 显式标注类型：Promise.all 对异构数组会把这一格塌成 {}，塌了之后
    // 下面传给 client 的 prop 类型就再也校验不到（改了数据形状 tsc 不会红）
    deptView ? listDeptPermissionView(id) : Promise.resolve({} as Record<string, DeptPermissionView>),
    roleView ? listProductionRolesWithPermissions(id) : Promise.resolve([]),
    overrideView ? listProductionMembersWithRoles(id) : Promise.resolve([]),
    overrideView ? getAllPermissionOverrides(id) : Promise.resolve({}),
    getPermissionVocabulary(id),
    approverView ? listResourceApprovers(id) : Promise.resolve([]),
    approverView ? listDelegableResourceTypes() : Promise.resolve([]),
  ]);

  return (
    <AdminPermissionCenterClient
      productionId={id}
      productionName={name ?? ""}
      depts={depts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, kind: d.kind, displayOrder: d.displayOrder, memberUserIds: d.memberUserIds }))}
      initialDeptRows={deptRows}
      initialRoles={roles.map(r => ({ id: r.id, name: r.name, permissions: r.permissions }))}
      members={membersRaw.map(m => ({
        userId: m.userId, name: m.name, roles: m.roles, tags: m.tags,
        email: canViewContact ? m.email : null,
        phone: canViewContact ? m.phone : null,
        status: m.status,
      }))}
      initialOverrides={overrides}
      vocabulary={vocabulary}
      initialApprovers={approvers}
      delegableTypes={delegableTypes}
      nonDelegableTypes={[...NON_DELEGABLE_RESOURCE_TYPES]}
      caps={{
        deptView, deptEdit,
        roleView, roleEdit,
        overrideView, overrideEdit,
        approverView, approverEdit,
        rootOperation: bypass,
      }}
    />
  );
}
