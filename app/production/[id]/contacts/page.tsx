import type { Metadata } from "next";
export const metadata: Metadata = { title: "人员" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext,
  getProductionName,
  listProductionMembersWithRoles,
  getAllPermissionOverrides,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { listEventDepartments } from "@/lib/event-db";
import ContactsClient from "@/components/ContactsClient";

export default async function ContactsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("view_contacts", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canManage = hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides);
  const canImport = hasPermission("import_contacts", session.isAdmin, memberRoles, overrides);
  const canManageDepts = hasPermission("dept:manage", session.isAdmin, memberRoles, overrides);

  const [name, members, allOverrides, departments] = await Promise.all([
    getProductionName(id),
    listProductionMembersWithRoles(id),
    canManage ? getAllPermissionOverrides(id) : Promise.resolve({} as Record<string, Record<string, boolean>>),
    listEventDepartments(id),
  ]);
  if (!name) redirect("/");

  return (
    <ContactsClient
      productionId={id}
      productionName={name}
      initialMembers={members}
      canImport={canImport}
      canManage={canManage}
      initialOverrides={allOverrides}
      canManageDepts={canManageDepts}
      initialDepartments={departments}
    />
  );
}
