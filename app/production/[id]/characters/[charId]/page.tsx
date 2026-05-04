import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getCharacterById, getProductionName, listCharactersByVersion, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import CharacterDetailView from "@/components/CharacterDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; charId: string }> }): Promise<Metadata> {
  const { id, charId } = await params;
  const cookieStore = await cookies();
  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;
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

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

  const versionId = cookieStore.get(`ver_${id}`)?.value ?? await getActiveVersionId(id) ?? null;

  const [name, character, allCharacters] = await Promise.all([
    getProductionName(id),
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
