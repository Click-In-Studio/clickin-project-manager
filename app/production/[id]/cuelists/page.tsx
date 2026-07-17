import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE表" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listCueLists } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { canCreateCueList, availableTemplatesForRoles } from "@/lib/cue-list-types";
import CueListsManager from "@/components/CueListsManager";

export default async function CueListsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const [name, cueLists] = await Promise.all([
    getProductionName(id),
    listCueLists(id),
  ]);
  if (!name) redirect("/");

  const roles = memberRoles ?? [];
  const canCreate = canCreateCueList(roles, session.isAdmin);
  const availableTemplates = availableTemplatesForRoles(roles, session.isAdmin);

  return (
    <CueListsManager
      productionId={id}
      initialCueLists={cueLists}
      canCreate={canCreate}
      availableTemplates={availableTemplates}
      myUserId={session.userId}
    />
  );
}
