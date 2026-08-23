import type { Metadata } from "next";
import { hasGrant } from "@/lib/grant-check";
export const metadata: Metadata = { title: "导入剧本内容" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getActiveVersionId } from "@/lib/db";
import ImportJointWizardPage from "@/components/import/ImportJointWizardPage";

export default async function ImportScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "script", "*", "imports", "create"))) redirect(`/production/${id}`);

  const versionId = await getActiveVersionId(id);

  return <ImportJointWizardPage productionId={id} versionId={versionId} />;
}
