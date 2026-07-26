import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext, getProductionName,
  getCueList, listCueListPermissions, listProductionMembersWithRoles,
  hasListAccess, listCueListRoleMembers,
} from "@/lib/db";
import { hasPermission, hasScopedPermission } from "@/lib/permissions";
import CueListDetail from "@/components/CueListDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; cueListId: string }> }): Promise<Metadata> {
  const { id, cueListId } = await params;
  const cueList = await getCueList(cueListId, id);
  return { title: cueList?.name ?? "CUE表" };
}

export default async function CueListDetailPage({
  params,
}: {
  params: Promise<{ id: string; cueListId: string }>;
}) {
  const { id, cueListId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !hasPermission("cue_list:view", access.permCtx)) redirect("/");
  const { permCtx } = access;

  const [name, cueList, permissions, members, canEdit, roleEditorUserIds] = await Promise.all([
    getProductionName(id),
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
    listProductionMembersWithRoles(id),
    hasListAccess(cueListId, session.userId),
    listCueListRoleMembers(cueListId),
  ]);
  if (!name || !cueList) redirect(`/production/${id}/cuelists`);

  const isCreator = cueList.createdBy === session.userId;
  const canManage = hasScopedPermission("cue_list:manage_permissions", "cue_list:manage_permissions_any", isCreator, permCtx);

  return (
    <CueListDetail
      productionId={id}
      productionName={name}
      initialCueList={cueList}
      initialPermissions={permissions}
      members={members}
      roleEditorUserIds={roleEditorUserIds}
      canEdit={canEdit}
      canManage={canManage}
      myUserId={session.userId}
    />
  );
}
