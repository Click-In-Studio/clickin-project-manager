import type { Metadata } from "next";
export const metadata: Metadata = { title: "场景" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listProductionScenes, listRehearsalMarksByScene } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import ScenesManager from "@/components/ScenesManager";

export default async function ScenesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

  const [name, scenes, rehearsalMarks] = await Promise.all([
    getProductionName(id),
    listProductionScenes(id),
    listRehearsalMarksByScene(id),
  ]);
  if (!name) redirect("/");

  return (
    <ScenesManager
      productionId={id}
      productionName={name}
      initialScenes={scenes}
      rehearsalMarks={rehearsalMarks}
      canEdit={canEdit}
    />
  );
}
