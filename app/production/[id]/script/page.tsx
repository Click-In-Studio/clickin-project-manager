import type { Metadata } from "next";
export const metadata: Metadata = { title: "剧本" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import ScriptEditor from "@/components/ScriptEditor";

export default async function ProductionScriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const p = (perm: Parameters<typeof hasPermission>[0]) =>
    hasPermission(perm, session.isAdmin, memberRoles, overrides);

  return (
    <ScriptEditor
      productionId={id}
      canEditText={p("script:edit")}
      canEditMetadata={p("script:metadata")}
      canEditRehearsalMark={p("script:rehearsal_mark")}
      canImport={p("manage_permissions")}
    />
  );
}
