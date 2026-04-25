import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { canUserAccessProduction, getProductionName, listProductionMembersWithRoles } from "@/lib/db";
import ContactsClient from "@/components/ContactsClient";

const MANAGER_ROLES = new Set(["制作人", "制作助理"]);

export default async function ContactsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.openId, id);
    if (!ok) redirect("/");
  }

  const [name, members] = await Promise.all([
    getProductionName(id),
    listProductionMembersWithRoles(id),
  ]);
  if (!name) redirect("/");

  const currentMember = members.find((m) => m.openId === session.openId);
  const canManage =
    session.isAdmin || (currentMember?.roles.some((r) => MANAGER_ROLES.has(r)) ?? false);

  return (
    <ContactsClient
      productionId={id}
      productionName={name}
      initialMembers={members}
      canManage={canManage}
    />
  );
}
