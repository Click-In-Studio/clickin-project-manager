import type { Metadata } from "next";
export const metadata: Metadata = { title: "戏剧构作" };

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
  listProductionScenes,
  listRehearsalMarksByScene,
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

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  if (!name) redirect("/");

  const resolvedVersionId = cookieVersionId
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;

  const [scenes, rehearsalMarks, characters] = resolvedVersionId
    ? await Promise.all([
        listScenesByVersion(resolvedVersionId),
        listRehearsalMarksByVersion(resolvedVersionId),
        listCharactersByVersion(resolvedVersionId),
      ])
    : await Promise.all([
        listProductionScenes(id),
        listRehearsalMarksByScene(id),
        Promise.resolve([]),
      ]);

  return (
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
    />
  );
}
