import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE表" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listCueLists, getUserAllowedCueTypes } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { CUE_LIST_TEMPLATES } from "@/lib/cue-list-types";
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

  const _access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!_access) redirect("/");
  const { permCtx } = _access;
  if (!hasPermission("cue_list:view", permCtx)) redirect("/");

  const canCreate = hasPermission("cue_list:create", permCtx);
  const canCreateAny = hasPermission("cue_list:create_any", permCtx);

  const [name, cueLists, allowedCueTypes] = await Promise.all([
    getProductionName(id),
    listCueLists(id),
    canCreate && !canCreateAny ? getUserAllowedCueTypes(session.userId, id) : Promise.resolve(null),
  ]);
  if (!name) redirect("/");

  const availableTemplates = canCreateAny
    ? CUE_LIST_TEMPLATES
    : CUE_LIST_TEMPLATES.filter((t) => allowedCueTypes?.includes(t.key));

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
