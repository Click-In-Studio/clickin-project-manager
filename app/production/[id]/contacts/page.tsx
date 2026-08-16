import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "人员" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getProductionName,
  listProductionMembersWithRoles,
} from "@/lib/db";
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
  if (!(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "member", "*", "meta", "view"))) redirect(`/unauthorized?resource=node%3Amember%2F*%2Fmeta%40view&id=${id}`);

  const canManage = (access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "member", "*", "overrides", "edit"));
  const canImport = (access.permCtx.isOwner || (access.permCtx.isAdmin && access.permCtx.memberPermissions === null) || await hasGrant(access.permCtx.userId, id, "member", "*", "imports", "create"));

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
