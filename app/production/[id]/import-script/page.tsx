import type { Metadata } from "next";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
export const metadata: Metadata = { title: "导入剧本内容" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getActiveVersionId } from "@/lib/script/version-db";
import ImportJointWizardPage from "@/components/import/ImportJointWizardPage";

export default async function ImportScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access || !await hasEffectiveGrant(access.permCtx, id, "script", "*", "imports", "create")) redirect(`/production/${id}`);

  const versionId = await getActiveVersionId(id);

  return <ImportJointWizardPage productionId={id} versionId={versionId} />;
}
