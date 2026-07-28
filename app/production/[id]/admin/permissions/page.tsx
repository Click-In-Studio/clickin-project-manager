import type { Metadata } from "next";
export const metadata: Metadata = { title: "人事权限" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { listProductionMembersWithRoles, getAllPermissionOverrides } from "@/lib/db";
import AdminPermissionsClient from "@/components/AdminPermissionsClient";

export default async function PermissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);
  const [members, overrides] = await Promise.all([
    listProductionMembersWithRoles(id),
    getAllPermissionOverrides(id),
  ]);
  return (
    <AdminPermissionsClient
      productionId={id}
      initialMembers={members}
      initialOverrides={overrides}
    />
  );
}
