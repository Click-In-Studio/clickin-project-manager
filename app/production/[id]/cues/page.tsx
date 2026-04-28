import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getProductionName,
  loadProduction, listCueLists, listCuesByProduction, listCueListPermissions,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { canEditCueList } from "@/lib/cue-list-types";
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

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const [name, production, cueLists, allCues] = await Promise.all([
    getProductionName(id),
    loadProduction(id),
    listCueLists(id),
    listCuesByProduction(id),
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
    />
  );
}
