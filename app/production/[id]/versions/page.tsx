import type { Metadata } from "next";
export const metadata: Metadata = { title: "版本管理" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, listVersions } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import VersionManagePage from "@/components/VersionManagePage";

export default async function VersionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, id);
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) redirect(`/production/${id}`);

  const [name, versions] = await Promise.all([
    getProductionName(id),
    listVersions(id),
  ]);
  if (!name) redirect("/");

  return (
    <VersionManagePage
      productionId={id}
      productionName={name}
      initialVersions={versions}
    />
  );
}
