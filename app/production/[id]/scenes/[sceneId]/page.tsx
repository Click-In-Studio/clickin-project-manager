import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getSceneById, getProductionName, listVersions, type SceneDetail } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import SceneDetailView from "@/components/SceneDetail";

export async function generateMetadata({ params }: { params: Promise<{ id: string; sceneId: string }> }): Promise<Metadata> {
  const { id, sceneId } = await params;
  const cookieStore = await cookies();
  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const versions = await listVersions(id);
  const versionId = (cookieVersionId && versions.some(v => v.id === cookieVersionId) ? cookieVersionId : null)
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;
  if (versionId) {
  }
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

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect("/");

  const canEdit = hasPermission("scene:rename", access.permCtx);

  const cookieVersionId = cookieStore.get(`ver_${id}`)?.value ?? null;
  const versions = await listVersions(id);
  const versionId = (cookieVersionId && versions.some(v => v.id === cookieVersionId) ? cookieVersionId : null)
    ?? versions.find(v => v.status === "editing")?.id
    ?? versions[0]?.id
    ?? null;
  if (versionId) {
  }

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
