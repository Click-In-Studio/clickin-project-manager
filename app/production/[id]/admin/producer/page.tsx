import type { Metadata } from "next";
export const metadata: Metadata = { title: "管理员设置" };

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
import { getPermissionVocabulary } from "@/lib/perm-center-db";
import AdminProducerClient from "@/components/AdminProducerClient";

export default async function ProducerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");
  const { permCtx } = access;

  // 编辑=ROOT（owner/平台 admin）；只读=producer 域显式 view（通配不穿透，
  // 制作人默认不可见本页）。
  const isRoot = permCtx.isAdmin || permCtx.isOwner;
  const canView = isRoot || await hasGrant(permCtx.userId, id, "producer", "*", "*", "view");
  if (!canView) redirect(`/production/${id}/admin`);

  const [name, roles, members, overrides, vocabulary] = await Promise.all([
    getProductionName(id),
    listProductionRolesWithPermissions(id),
    listProductionMembersWithRoles(id),
    getAllPermissionOverrides(id),
    getPermissionVocabulary(id),
  ]);

  const producerRole = roles.find(r => r.name === "制作人") ?? null;

  // 治理域 override（node:production/ 与 node:producer/ 前缀）
  const governance: { userId: string; permission: string; granted: boolean }[] = [];
  for (const [userId, perms] of Object.entries(overrides)) {
    for (const [permission, granted] of Object.entries(perms)) {
      if (permission.startsWith("node:production/") || permission.startsWith("node:producer/")) {
        governance.push({ userId, permission, granted });
      }
    }
  }

  return (
    <AdminProducerClient
      productionId={id}
      productionName={name ?? ""}
      producerRole={producerRole ? { id: producerRole.id, permissions: producerRole.permissions } : null}
      members={members.map(m => ({ userId: m.userId, name: m.name, roles: m.roles, status: m.status }))}
      initialGovernance={governance}
      vocabulary={vocabulary}
      isRoot={isRoot}
    />
  );
}
