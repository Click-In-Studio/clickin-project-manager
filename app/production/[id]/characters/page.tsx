import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listCharactersByVersion, listVersions } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
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

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!hasPermission("character:view", access.permCtx)) redirect(`/unauthorized?resource=character%3Aview&id=${id}`);

  const canEdit = hasPermission("scene:rename", access.permCtx);

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  if (!name) notFound();
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
