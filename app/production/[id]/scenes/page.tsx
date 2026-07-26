import type { Metadata } from "next";
export const metadata: Metadata = { title: "场景" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listVersions, listScenesByVersion, listRehearsalMarksByVersion, ensureScriptMarkerMigration } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import ScenesManager from "@/components/ScenesManager";

export default async function ScenesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");

  const canEdit = hasPermission("scene:rename", access.permCtx);
  const canImport = hasPermission("dramaturgy:import", access.permCtx);

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const [name, versions] = await Promise.all([getProductionName(id), listVersions(id)]);
  if (!name) redirect("/");

  const validCookieVersionId = cookieVersionId && versions.some(v => v.id === cookieVersionId)
    ? cookieVersionId
    : null;
  const resolvedVersionId = validCookieVersionId
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;

  const [scenes, rehearsalMarks] = resolvedVersionId
    ? await (async () => {
        const migration = await ensureScriptMarkerMigration(resolvedVersionId);
        if (migration.status === "running") redirect(`/production/${id}/script?v=${resolvedVersionId}`);
        return Promise.all([listScenesByVersion(resolvedVersionId), listRehearsalMarksByVersion(resolvedVersionId)]);
      })()
    : [[] as Awaited<ReturnType<typeof listScenesByVersion>>, {} as Awaited<ReturnType<typeof listRehearsalMarksByVersion>>];

  return (
    <ScenesManager
      productionId={id}
      productionName={name}
      initialScenes={scenes}
      rehearsalMarks={rehearsalMarks}
      canEdit={canEdit}
      canImport={canImport}
      versions={versions}
      versionId={resolvedVersionId}
    />
  );
}
