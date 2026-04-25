import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getSceneById, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import SceneDetail from "@/components/SceneDetail";

export default async function SceneDetailPage({
  params,
}: {
  params: Promise<{ id: string; sceneId: string }>;
}) {
  const { id, sceneId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

  const [name, scene] = await Promise.all([
    getProductionName(id),
    getSceneById(sceneId, id),
  ]);
  if (!name || !scene) redirect(`/production/${id}/script`);

  return (
    <SceneDetail
      productionId={id}
      productionName={name}
      scene={scene}
      canEdit={canEdit}
    />
  );
}
