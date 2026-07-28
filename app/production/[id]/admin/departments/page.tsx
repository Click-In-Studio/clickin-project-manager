import type { Metadata } from "next";
export const metadata: Metadata = { title: "部门管理" };

import { requireAdminAccess } from "@/lib/admin-guard";
import { listEventDepartments } from "@/lib/event-db";
import { listProductionMembersWithRoles } from "@/lib/db";
import AdminDepartmentsClient from "@/components/AdminDepartmentsClient";

export default async function DepartmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminAccess(id);

  const [departments, members] = await Promise.all([
    listEventDepartments(id),
    listProductionMembersWithRoles(id),
  ]);

  return (
    <AdminDepartmentsClient
      productionId={id}
      initialDepartments={departments}
      members={members}
    />
  );
}
