import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listCharactersByVersion, listVersions } from "@/lib/db";
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

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  if (!name) redirect("/");
  const versionId = (cookieVersionId && versions.some(v => v.id === cookieVersionId) ? cookieVersionId : null)
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;
  const characters = versionId ? await listCharactersByVersion(versionId) : [];

  return (
    <CharactersManager
      productionId={id}
      productionName={name}
      initialCharacters={characters}
      canEdit={canEdit}
      versionId={versionId}
    />
  );
}
