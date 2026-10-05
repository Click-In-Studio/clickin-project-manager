import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { hasAnyEffectiveGrant } from "@/lib/perm/grant-check";
import { getCharacterPerms } from "@/lib/script/character-perms";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getCharacterById, listCharactersByVersion } from "@/lib/script/script-scene-character-db";
import { getProductionName } from "@/lib/production/production-db";
import { getActiveVersionId } from "@/lib/script/version-db";
import CharacterDetailView from "@/components/script/CharacterDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; charId: string }> }): Promise<Metadata> {
  const { id, charId } = await params;
  const versionId = await getActiveVersionId(id);
  const character = versionId ? await getCharacterById(charId, id, versionId) : null;
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
  if (!await hasAnyEffectiveGrant(access.permCtx, id, "character", ["meta"], "view"))
    redirect(`/unauthorized?resource=node%3Acharacter%2F*%2Fmeta%40view&id=${id}`);

  // 与列表页同源：详情页也保留 create/edit/delete 与实例级角色权限，不用粗门代替。
  const perms = await getCharacterPerms(
    session.userId, id, access.permCtx.isAdmin || access.permCtx.isOwner,
  );

  const [name, versionId] = await Promise.all([
    getProductionName(id),
    getActiveVersionId(id),
  ]);
  const [character, allCharacters] = await Promise.all([
    versionId ? getCharacterById(charId, id, versionId) : Promise.resolve(null),
    versionId ? listCharactersByVersion(versionId) : Promise.resolve([]),
  ]);
  if (!name || !character) redirect(`/production/${id}/characters`);

  return (
    <CharacterDetailView
      productionId={id}
      productionName={name}
      character={character}
      allCharacters={allCharacters}
      perms={perms}
      versionId={versionId}
    />
  );
}
