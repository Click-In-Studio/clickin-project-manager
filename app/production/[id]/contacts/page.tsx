import type { Metadata } from "next";
export const metadata: Metadata = { title: "人员" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
} from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
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
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!hasPermission("contacts:view", access.permCtx)) redirect(`/unauthorized?resource=contacts%3Aview&id=${id}`);

  const canManage = hasPermission("members:manage_overrides", access.permCtx);
  const canImport = hasPermission("contacts:import", access.permCtx);

  const [name, members] = await Promise.all([
    getProductionName(id),
    listProductionMembersWithRoles(id),
  ]);
  if (!name) notFound();

  return (
    <ContactsClient
      productionId={id}
      productionName={name}
      initialMembers={members}
      canImport={canImport}
      canManage={canManage}
      myUserId={session.userId}
    />
  );
}
