import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasGrant, hasAnyGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getCharacterById, getProductionName, listCharactersByVersion, getActiveVersionId } from "@/lib/db";
import CharacterDetailView from "@/components/CharacterDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; charId: string }> }): Promise<Metadata> {
  const { id, charId } = await params;
  const versionId = await getActiveVersionId(id);
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

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!access.permCtx.isAdmin && !access.permCtx.isOwner && !await hasAnyGrant(session.userId, id, "character", ["meta"], "view"))
    redirect(`/unauthorized?resource=node%3Acharacter%2F*%2Fmeta%40view&id=${id}`);

  // owner 旁路（#228 漏网）；域对齐 API 真相：character 编辑门是 character/*@edit（原 scene meta/name 为复制残留）
  const canEdit = access.permCtx.isAdmin || access.permCtx.isOwner
    || await hasGrant(session.userId, id, "character", "*", "*", "edit");

  const [name, versionId] = await Promise.all([
    getProductionName(id),
    getActiveVersionId(id),
  ]);
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
