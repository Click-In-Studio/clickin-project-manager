import type { Metadata } from "next";
export const metadata: Metadata = { title: "戏剧构作" };

import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getProductionName,
  listVersions,
  listMarkerProjectionByVersion,
  listCharactersByVersion,
} from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import Dramaturgy from "@/components/Dramaturgy";

export default async function DramaturgyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; sceneId?: string }>;
}) {
  const { id } = await params;
  const { v, sceneId } = await searchParams;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${id}`);

  const canEdit = hasPermission("scene:rename", access.permCtx);

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  if (!name) notFound();

  const validCookieVersionId = cookieVersionId && versions.some(ver => ver.id === cookieVersionId)
    ? cookieVersionId
    : null;
  const resolvedVersionId =
    (v && versions.some(ver => ver.id === v) ? v : null)
    ?? validCookieVersionId
    ?? versions.find(ver => ver.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;

  const [scenes] = resolvedVersionId
    ? await Promise.all([
        listMarkerProjectionByVersion(resolvedVersionId),
        listCharactersByVersion(resolvedVersionId),
      ])
    : [[]];

  return (
    <Suspense>
      <Dramaturgy
        productionId={id}
        productionName={name}
        versionId={resolvedVersionId}
        initialScenes={scenes}
        canEdit={canEdit}
        initialSceneId={sceneId}
      />
    </Suspense>
  );
}
