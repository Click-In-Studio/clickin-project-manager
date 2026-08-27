import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasAnyGrant } from "@/lib/grant-check";
import { getCharacterPerms } from "@/lib/character-perms";
import { getProductionPermissionContext, getProductionName, listCharactersByVersion, getActiveVersionId } from "@/lib/db";
import CharactersManager from "@/components/CharactersManager";
import PageActivationGate from "@/components/PageActivationGate";

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
  if (!access.permCtx.isAdmin && !access.permCtx.isOwner && !await hasAnyGrant(session.userId, id, "character", ["meta"], "view"))
    redirect(`/unauthorized?resource=node%3Acharacter%2F*%2Fmeta%40view&id=${id}`);

  // owner 旁路（#228 漏网）。三枚键分开算：判定端 create/edit/delete 是三条不同的
  // 路由门，用单一 canEdit 当总门会与后端错位（见 lib/character-perms.ts）。
  const perms = await getCharacterPerms(
    session.userId, id, access.permCtx.isAdmin || access.permCtx.isOwner,
  );

  const [name, versionId] = await Promise.all([
    getProductionName(id),
    getActiveVersionId(id),
  ]);
  if (!name) notFound();
  const characters = versionId ? await listCharactersByVersion(versionId) : [];

  return (
    <>
      <CharactersManager
        productionId={id}
        productionName={name}
        initialCharacters={characters}
        perms={perms}
        versionId={versionId}
      />
      <PageActivationGate productionId={id} scope="characters" />
    </>
  );
}
