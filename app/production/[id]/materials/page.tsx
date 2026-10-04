import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { getProductionName } from "@/lib/production/production-db";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { getMaterialOverview, listMaterials } from "@/lib/ops/material-db";
import PageActivationGate from "@/components/perm/PageActivationGate";
import { getMaterialCapabilities } from "@/lib/ops/material-capabilities";
import MaterialsClient from "@/components/ops/materials/MaterialsClient";

export const metadata: Metadata = { title: "物料台账" };

export default async function MaterialsPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) notFound();

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  const actor = toActor(session, access.permCtx);
  if (!await hasEffectiveGrant(actor, id, "material", "*", "*", "view"))
    redirect(`/unauthorized?resource=node%3Amaterial%2F*%40view&id=${id}`);

  const [materials, overview] = await Promise.all([listMaterials(id), getMaterialOverview(id)]);
  const capabilities = await getMaterialCapabilities(actor, id, access.isArchived, materials);

  return (
    <>
      <PageActivationGate productionId={id} scope="materials" />
      <MaterialsClient productionId={id} currentUserId={session.userId} archived={access.isArchived}
        initialMaterials={materials} initialOverview={overview} initialCapabilities={capabilities} />
    </>
  );
}
