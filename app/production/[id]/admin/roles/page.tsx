import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色管理" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { listProductionRolesWithPermissions } from "@/lib/db";
import AdminRolesClient from "@/components/AdminRolesClient";

export default async function RolesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  const roles = await listProductionRolesWithPermissions(id);
  return <AdminRolesClient productionId={id} initialRoles={roles} />;
}
