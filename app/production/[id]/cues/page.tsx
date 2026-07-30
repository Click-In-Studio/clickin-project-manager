import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext, getProductionName,
  loadProduction, listCueLists, listCuesByProduction,
  getActiveVersionId, getVersion, listVersions, hasListAccess,
} from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { computePageMap } from "@/lib/script-page";
import CuePage from "@/components/CuePage";

export default async function CuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { id } = await params;
  const { v } = await searchParams;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const _access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!_access) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${id}`);
  if (!hasPermission("cue_list:view", _access.permCtx)) redirect(`/unauthorized?resource=${encodeURIComponent("Cue 表")}&id=${id}`);

  const versions = await listVersions(id);
  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const validUrlVersionId = v && versions.some(ver => ver.id === v) ? v : null;
  const validCookieVersionId = cookieVersionId && versions.some(ver => ver.id === cookieVersionId)
    ? cookieVersionId
    : null;

  // Resolve version: URL param > cookie > active version
  const resolvedVersionId =
    validUrlVersionId
    ?? validCookieVersionId
    ?? await getActiveVersionId(id);
  if (resolvedVersionId) {
  }

  const [name, production, cueLists, allCues, version] = await Promise.all([
    getProductionName(id),
    resolvedVersionId ? loadProduction(id, resolvedVersionId) : Promise.resolve(null),
    listCueLists(id),
    listCuesByProduction(id, resolvedVersionId ?? undefined),
    resolvedVersionId ? getVersion(resolvedVersionId) : Promise.resolve(null),
  ]);
  if (!name) notFound();
  if (!production) notFound();

  const editableListIds = new Set<string>(
    (await Promise.all(cueLists.map(async (cl) => ({
      id: cl.id,
      canEdit: await hasListAccess(cl.id, session.userId),
    })))).filter(r => r.canEdit).map(r => r.id)
  );

  const pageLayout = production.state.config.pageLayout;
  const pageMap: Record<string, number> = computePageMap(production.state.blocks, pageLayout);

  return (
    <CuePage
      productionId={id}
      productionName={name}
      blocks={production.state.blocks}
      characters={production.state.characters}
      scenes={production.state.scenes}
      cueLists={cueLists}
      initialCues={allCues}
      editableListIds={[...editableListIds]}
      myUserId={session.userId}
      isAdmin={session.isAdmin}
      pageMap={pageMap}
      versions={versions}
      versionId={resolvedVersionId ?? undefined}
      versionStatus={version?.status ?? undefined}
    />
  );
}
