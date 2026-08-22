import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext, getProductionName,
  loadProduction, listCueLists, listCuesByProduction,
  getActiveVersionId, listCueListsWithAccess,
} from "@/lib/db";
import { computePageMap } from "@/lib/script-page";
import CuePage from "@/components/CuePage";

export default async function CuesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const _access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!_access) redirect(`/unauthorized?id=${id}`);
  // 批A：成员即可进页面，可见 cue 表由 view 行过滤（admin/owner 全量）
  const seeAllLists = _access.permCtx.isAdmin || _access.permCtx.isOwner;

  const resolvedVersionId = await getActiveVersionId(id);

  const [name, production, cueListsWithAccess, allCues] = await Promise.all([
    getProductionName(id),
    resolvedVersionId ? loadProduction(id, resolvedVersionId) : Promise.resolve(null),
    listCueListsWithAccess(id, session.userId, { seeAll: seeAllLists }),
    listCuesByProduction(id, resolvedVersionId ?? undefined),
  ]);
  if (!name) notFound();
  if (!production) notFound();

  const cueLists = cueListsWithAccess;
  const editableListIds = cueListsWithAccess.filter(cl => cl.canEdit).map(cl => cl.id);
  const manageListIds = cueListsWithAccess.filter(cl => cl.canManage).map(cl => cl.id);

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
      editableListIds={editableListIds}
      manageListIds={manageListIds}
      myUserId={session.userId}
      isAdmin={session.isAdmin}
      pageMap={pageMap}
      versionId={resolvedVersionId ?? undefined}
    />
  );
}
