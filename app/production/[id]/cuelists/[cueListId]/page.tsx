import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getProductionName,
  getCueList, listCueListPermissions, listProductionMembersWithRoles,
} from "@/lib/db";

export async function generateMetadata({ params }: { params: Promise<{ id: string; cueListId: string }> }): Promise<Metadata> {
  const { id, cueListId } = await params;
  const cueList = await getCueList(cueListId, id);
  return { title: cueList?.name ?? "走位表" };
}
import { hasPermission } from "@/lib/roles";
import { canEditCueList, canManageCueListPermissions } from "@/lib/cue-list-types";
import CueListDetail from "@/components/CueListDetail";

export default async function CueListDetailPage({
  params,
}: {
  params: Promise<{ id: string; cueListId: string }>;
}) {
  const { id, cueListId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("cue:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const [name, cueList, permissions, members] = await Promise.all([
    getProductionName(id),
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
    listProductionMembersWithRoles(id),
  ]);
  if (!name || !cueList) redirect(`/production/${id}/cuelists`);

  const canEdit = canEditCueList(session.openId, memberRoles, session.isAdmin, cueList, permissions);
  const canManage = canManageCueListPermissions(session.openId, memberRoles, session.isAdmin, cueList);

  return (
    <CueListDetail
      productionId={id}
      productionName={name}
      initialCueList={cueList}
      initialPermissions={permissions}
      members={members}
      canEdit={canEdit}
      canManage={canManage}
      myOpenId={session.openId}
    />
  );
}
