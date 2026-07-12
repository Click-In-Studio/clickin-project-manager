import type { Metadata } from "next";
export const metadata: Metadata = { title: "场景" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listVersions, listMarkerProjectionByVersion, ensureScriptMarkerMigration } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
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

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);
  const canImport = hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides);

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

  const scenes = resolvedVersionId
    ? await (async () => {
        const migration = await ensureScriptMarkerMigration(resolvedVersionId);
        if (migration.status === "running") redirect(`/production/${id}/script?v=${resolvedVersionId}`);
        return listMarkerProjectionByVersion(id, resolvedVersionId);
      })()
    : [];
  return (
    <ScenesManager
      productionId={id}
      productionName={name}
      initialScenes={scenes}
      canEdit={canEdit}
      canImport={canImport}
      versions={versions}
      versionId={resolvedVersionId}
    />
  );
}
