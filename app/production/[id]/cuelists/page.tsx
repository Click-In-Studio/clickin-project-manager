import type { Metadata } from "next";
export const metadata: Metadata = { title: "CUE表" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listCueListsWithAccess, getUserAllowedCueTypes, listProductionMembersWithRoles } from "@/lib/db";
import { canAccessNode } from "@/lib/grant-template";
import { CUE_LIST_TEMPLATES } from "@/lib/cue-list-types";
import CueListsManager from "@/components/CueListsManager";
import PageActivationGate from "@/components/PageActivationGate";

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
  if (!_access) redirect(`/unauthorized?id=${id}`);
  const { permCtx } = _access;
  // 批A：目录三态——成员即可进目录页，可见条目由 meta view 行过滤（admin/owner 全量）
  const seeAll = permCtx.isAdmin || permCtx.isOwner;

  const [canCreateRes, name, cueListsWithAccess, members] = await Promise.all([
    canAccessNode(permCtx, id, "cue_list", "*", "*", "create"),
    getProductionName(id),
    listCueListsWithAccess(id, session.userId, { seeAll }),
    listProductionMembersWithRoles(id),
  ]);
  const canCreate = canCreateRes.allowed;
  const canCreateAny = seeAll; // create_any 已并入 create；admin/owner 越过模板类型限制
  const allowedCueTypes = canCreate && !canCreateAny
    ? await getUserAllowedCueTypes(session.userId, id)
    : null;
  if (!name) notFound();

  const availableTemplates = canCreateAny
    ? CUE_LIST_TEMPLATES
    : CUE_LIST_TEMPLATES.filter((t) => allowedCueTypes?.includes(t.key));

  const editableIds = cueListsWithAccess.filter(cl => cl.canEdit).map(cl => cl.id);

  return (
    <>
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
      <PageActivationGate productionId={id} scope="cuelists" />
    </>
  );
}
