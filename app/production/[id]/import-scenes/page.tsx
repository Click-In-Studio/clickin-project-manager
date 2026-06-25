import type { Metadata } from "next";
export const metadata: Metadata = { title: "导入章节信息" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import ImportScenesWizardPage from "@/components/import/ImportScenesWizardPage";

export default async function ImportScenesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) redirect(`/production/${id}`);

  const versionId = cookieStore.get(`ver_${id}`)?.value ?? null;

  return <ImportScenesWizardPage productionId={id} versionId={versionId} />;
}
