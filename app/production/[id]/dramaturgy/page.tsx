import type { Metadata } from "next";
export const metadata: Metadata = { title: "戏剧构作" };

import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasAnyGrant } from "@/lib/grant-check";
import { getSceneFieldPerms } from "@/lib/scene-field-perms";
import {
  getProductionPermissionContext,
  getProductionName,
  listVersions,
  listMarkerProjectionByVersion,
  listCharactersByVersion,
} from "@/lib/db";
import Dramaturgy from "@/components/Dramaturgy";
import PageActivationGate from "@/components/PageActivationGate";

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
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!access.permCtx.isAdmin && !access.permCtx.isOwner && !await hasAnyGrant(session.userId, id, "scene", ["meta"], "view"))
    redirect(`/unauthorized?resource=node%3Ascene%2F*%2Fmeta%40view&id=${id}`);

  // 逐字段权限：scene 的每个字段各有一把钥匙（lib/scene-field-perms）。
  // canEdit 只是「值得显示编辑态」的粗门——具体哪个字段能改看 fieldPerms。
  const fieldPerms = await getSceneFieldPerms(
    session.userId, id, access.permCtx.isAdmin || access.permCtx.isOwner,  // owner 旁路（#228 漏网）
  );
  const canEdit = fieldPerms.any;

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
    <>
      <Suspense>
        <Dramaturgy
          productionId={id}
          productionName={name}
          versionId={resolvedVersionId}
          initialScenes={scenes}
          canEdit={canEdit}
          fieldPerms={fieldPerms}
          initialSceneId={sceneId}
        />
      </Suspense>
      <PageActivationGate productionId={id} scope="dramaturgy" />
    </>
  );
}
