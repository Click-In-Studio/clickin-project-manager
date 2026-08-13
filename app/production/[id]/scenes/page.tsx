import type { Metadata } from "next";
export const metadata: Metadata = { title: "场景" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasGrant, hasAnyGrant } from "@/lib/grant-check";
import { getProductionPermissionContext, getProductionName, listVersions, listMarkerProjectionByVersion } from "@/lib/db";
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
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!access.permCtx.isAdmin && !await hasAnyGrant(session.userId, id, "scene", ["meta"], "view"))
    redirect(`/unauthorized?resource=node%3Ascene%2F*%2Fmeta%40view&id=${id}`);

  const canEdit = access.permCtx.isAdmin
    || await hasGrant(session.userId, id, "scene", "*", "meta/name", "edit");
  const canImport = (access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, id, "dramaturgy", "*", "imports", "create"));

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const [name, versions] = await Promise.all([getProductionName(id), listVersions(id)]);
  if (!name) notFound();

  const validCookieVersionId = cookieVersionId && versions.some(v => v.id === cookieVersionId)
    ? cookieVersionId
    : null;
  const resolvedVersionId = validCookieVersionId
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;

  const scenes = resolvedVersionId
    ? await (async () => {
        return listMarkerProjectionByVersion(resolvedVersionId);
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
