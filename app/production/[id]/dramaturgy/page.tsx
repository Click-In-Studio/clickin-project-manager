import type { Metadata } from "next";
export const metadata: Metadata = { title: "戏剧构作" };

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext,
  getProductionName,
  listVersions,
  listScenesByVersion,
  listCharactersByVersion,
  listRehearsalMarksByVersion,
  ensureScriptMarkerMigration,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import Dramaturgy from "@/components/Dramaturgy";

export default async function DramaturgyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; sceneId?: string; characterId?: string }>;
}) {
  const { id } = await params;
  const { v, sceneId, characterId } = await searchParams;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);
  const canImport = hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides);

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  if (!name) redirect("/");

  // Resolve version: URL param > cookie > editing version > first
  const validCookieVersionId = cookieVersionId && versions.some(ver => ver.id === cookieVersionId)
    ? cookieVersionId
    : null;
  const resolvedVersionId =
    (v && versions.some(ver => ver.id === v) ? v : null)
    ?? validCookieVersionId
    ?? versions.find(ver => ver.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;

  const [scenes, rehearsalMarks, characters] = resolvedVersionId
    ? await (async () => {
        const migration = await ensureScriptMarkerMigration(resolvedVersionId);
        if (migration.status === "running") redirect(`/production/${id}/script?v=${resolvedVersionId}`);
        return Promise.all([
          listScenesByVersion(resolvedVersionId),
          listRehearsalMarksByVersion(resolvedVersionId),
          listCharactersByVersion(resolvedVersionId),
        ]);
      })()
    : [[], {}, []];

  return (
    <Suspense>
      <Dramaturgy
        productionId={id}
        productionName={name}
        versions={versions}
        versionId={resolvedVersionId}
        initialScenes={scenes}
        rehearsalMarks={rehearsalMarks}
        initialCharacters={characters}
        canEdit={canEdit}
        canImport={canImport}
        initialSceneId={sceneId}
        initialCharacterId={characterId}
      />
    </Suspense>
  );
}
