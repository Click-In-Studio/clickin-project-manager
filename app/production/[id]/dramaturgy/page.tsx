import type { Metadata } from "next";
export const metadata: Metadata = { title: "戏剧构作" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext,
  getProductionName,
  listProductionScenes,
  listRehearsalMarksByScene,
  listProductionCharacters,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import Dramaturgy from "@/components/Dramaturgy";

export default async function DramaturgyPage({
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
  const canImport = hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides);

  const [name, scenes, rehearsalMarks, characters] = await Promise.all([
    getProductionName(id),
    listProductionScenes(id),
    listRehearsalMarksByScene(id),
    listProductionCharacters(id),
  ]);
  if (!name) redirect("/");

  return (
    <Dramaturgy
      productionId={id}
      productionName={name}
      initialScenes={scenes}
      rehearsalMarks={rehearsalMarks}
      initialCharacters={characters}
      canEdit={canEdit}
      canImport={canImport}
    />
  );
}
