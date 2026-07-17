import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getCharacterById, getProductionName, listCharactersByVersion, listVersions } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import CharacterDetailView from "@/components/CharacterDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; charId: string }> }): Promise<Metadata> {
  const { id, charId } = await params;
  const cookieStore = await cookies();
  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const versions = await listVersions(id);
  const versionId = (cookieVersionId && versions.some(v => v.id === cookieVersionId) ? cookieVersionId : null)
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;
  const character = await getCharacterById(charId, id, versionId);
  return { title: character?.name ?? "角色" };
}

export default async function CharacterDetailPage({
  params,
}: {
  params: Promise<{ id: string; charId: string }>;
}) {
  const { id, charId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  const versionId = (cookieVersionId && versions.some(v => v.id === cookieVersionId) ? cookieVersionId : null)
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;
  const [character, allCharacters] = await Promise.all([
    getCharacterById(charId, id, versionId),
    versionId ? listCharactersByVersion(versionId) : Promise.resolve([]),
  ]);
  if (!name || !character) redirect(`/production/${id}/characters`);

  return (
    <CharacterDetailView
      productionId={id}
      productionName={name}
      character={character}
      allCharacters={allCharacters}
      canEdit={canEdit}
      versionId={versionId}
    />
  );
}
