import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE表" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listCueListsWithAccess, getUserAllowedCueTypes, listProductionMembersWithRoles } from "@/lib/db";
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
  if (!_access) redirect(`/unauthorized?resource=${encodeURIComponent("项目")}&id=${id}`);
  const { permCtx } = _access;
  if (!hasPermission("cue_list:view", permCtx)) redirect(`/unauthorized?resource=${encodeURIComponent("Cue 表")}&id=${id}`);

  const canCreate = hasPermission("cue_list:create", permCtx);
  const canCreateAny = hasPermission("cue_list:create_any", permCtx);

  const [name, cueListsWithAccess, allowedCueTypes, members] = await Promise.all([
    getProductionName(id),
    listCueListsWithAccess(id, session.userId),
    canCreate && !canCreateAny ? getUserAllowedCueTypes(session.userId, id) : Promise.resolve(null),
    listProductionMembersWithRoles(id),
  ]);
  if (!name) notFound();

  const availableTemplates = canCreateAny
    ? CUE_LIST_TEMPLATES
    : CUE_LIST_TEMPLATES.filter((t) => allowedCueTypes?.includes(t.key));

  const editableIds = cueListsWithAccess.filter(cl => cl.canEdit).map(cl => cl.id);

  return (
    <CueListsManager
      productionId={id}
      productionName={name}
      initialCueLists={cueListsWithAccess}
      canCreate={canCreate}
      availableTemplates={availableTemplates}
      myUserId={session.userId}
      editableIds={editableIds}
      members={members}
    />
  );
}
