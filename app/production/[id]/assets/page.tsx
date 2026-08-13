import type { Metadata } from "next";
export const metadata: Metadata = { title: "Assets" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasAnyGrant } from "@/lib/grant-check";
import { getProductionPermissionContext } from "@/lib/db";
import AssetPageClient from "@/components/assets/AssetPageClient";
import PageActivationGate from "@/components/PageActivationGate";

export default async function AssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  // 批D：能力票（meta@view 实例或通配）
  if (!access.permCtx.isAdmin && !await hasAnyGrant(session.userId, id, "asset", ["meta"], "view"))
    redirect(`/unauthorized?resource=node%3Aasset%2F*%2Fmeta%40view&id=${id}`);

  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  return (
    <>
      <AssetPageClient
        productionId={id}
        versionId={versionId}
        myUserId={session.userId}
        isAdmin={session.isAdmin}
        userName={session.name}
      />
      <PageActivationGate productionId={id} scope="assets" />
    </>
  );
}
