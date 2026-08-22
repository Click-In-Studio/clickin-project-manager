import type { Metadata } from "next";
export const metadata: Metadata = { title: "角色" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasGrant, hasAnyGrant } from "@/lib/grant-check";
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

  // owner 旁路（#228 漏网）；域对齐 API 真相：character 编辑门是 character/*@edit（原 scene meta/name 为复制残留）
  const canEdit = access.permCtx.isAdmin || access.permCtx.isOwner
    || await hasGrant(session.userId, id, "character", "*", "*", "edit");

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
        canEdit={canEdit}
        versionId={versionId}
      />
      <PageActivationGate productionId={id} scope="characters" />
    </>
  );
}
