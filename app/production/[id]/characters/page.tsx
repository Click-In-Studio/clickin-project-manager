import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listProductionCharacters } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import CharactersManager from "@/components/CharactersManager";

export default async function CharactersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

  const [name, characters] = await Promise.all([
    getProductionName(id),
    listProductionCharacters(id),
  ]);
  if (!name) redirect("/");

  return (
    <CharactersManager
      productionId={id}
      productionName={name}
      initialCharacters={characters}
      canEdit={canEdit}
    />
  );
}
