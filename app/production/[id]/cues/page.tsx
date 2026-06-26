import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getProductionName,
  loadProduction, listCueLists, listCuesByProduction, listCueListPermissions,
  getActiveVersionId, getVersion, listVersions, ensureScriptMarkerMigration,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { canEditCueList } from "@/lib/cue-list-types";
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

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides)) redirect("/");

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
    const migration = await ensureScriptMarkerMigration(resolvedVersionId);
    if (migration.status === "running") redirect(`/production/${id}/script?v=${resolvedVersionId}`);
  }

  const [name, production, cueLists, allCues, version] = await Promise.all([
    getProductionName(id),
    resolvedVersionId ? loadProduction(id, resolvedVersionId) : Promise.resolve(null),
    listCueLists(id),
    listCuesByProduction(id, resolvedVersionId ?? undefined),
    resolvedVersionId ? getVersion(resolvedVersionId) : Promise.resolve(null),
  ]);
  if (!name || !production) redirect("/");

  // Determine per-list edit permission for the current user
  const editableListIds = new Set<string>();
  await Promise.all(
    cueLists.map(async (cl) => {
      const perms = await listCueListPermissions(cl.id);
      if (canEditCueList(session.openId, memberRoles, session.isAdmin, cl, perms))
        editableListIds.add(cl.id);
    })
  );

  const pageLayout = production.state.config.pageLayout;
  const pageMap: Record<string, number> = computePageMap(production.state.blocks, pageLayout);

  const canManageVersions = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

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
      myOpenId={session.openId}
      isAdmin={session.isAdmin}
      pageMap={pageMap}
      versions={versions}
      versionId={resolvedVersionId ?? undefined}
      versionStatus={version?.status ?? undefined}
      canManageVersions={canManageVersions}
    />
  );
}
