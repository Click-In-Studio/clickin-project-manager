import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getSceneById, getProductionName, type SceneDetail } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import SceneDetailView from "@/components/SceneDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; sceneId: string }> }): Promise<Metadata> {
  const { id, sceneId } = await params;
  const cookieStore = await cookies();
  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const scene = await getSceneById(sceneId, id, versionId);
  return { title: scene?.name ?? "场景" };
}

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

  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  const [name, scene] = await Promise.all([
    getProductionName(id),
    getSceneById(sceneId, id, versionId),
  ]);
  if (!name || !scene) redirect(`/production/${id}/script`);

  return (
    <SceneDetailView
      productionId={id}
      productionName={name}
      scene={scene as SceneDetail}
      canEdit={canEdit}
      versionId={versionId}
    />
  );
}
