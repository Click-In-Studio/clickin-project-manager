import type { Metadata } from "next";
export const metadata: Metadata = { title: "导入剧本内容" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import ImportJointWizardPage from "@/components/import/ImportJointWizardPage";

export default async function ImportScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !hasPermission("script:import", access.permCtx)) redirect(`/production/${id}`);

  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  return <ImportJointWizardPage productionId={id} versionId={versionId} />;
}
