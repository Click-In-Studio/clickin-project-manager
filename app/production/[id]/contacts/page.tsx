import type { Metadata } from "next";
export const metadata: Metadata = { title: "人员" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
  getAllPermissionOverrides,
} from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
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

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");

  const canManage = hasPermission("members:manage_overrides", access.permCtx);
  const canImport = hasPermission("contacts:import", access.permCtx);
  const canManageDepts = hasPermission("dept:create", access.permCtx);

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
      myUserId={session.userId}
      initialOverrides={allOverrides}
      canManageDepts={canManageDepts}
      initialDepartments={departments}
    />
  );
}
