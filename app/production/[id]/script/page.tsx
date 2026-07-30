import type { Metadata } from "next";
export const metadata: Metadata = { title: "剧本" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import ScriptEditor from "@/components/ScriptEditor";

export default async function ProductionScriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; q?: string }>;
}) {
  const { id } = await params;
  const { v, q } = await searchParams;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, name] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, id),
    getProductionName(id),
  ]);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!hasPermission("script:view", access.permCtx)) redirect(`/unauthorized?resource=script%3Aview&id=${id}`);

  const p = (perm: Parameters<typeof hasPermission>[0]) =>
    hasPermission(perm, access.permCtx);

  // Resolve initial version: URL param > cookie
  const versionId = v ?? cookieStore.get(`ver_${id}`)?.value ?? null;

  return (
    <ScriptEditor
      productionId={id}
      productionName={name ?? undefined}
      canEditText={p("script:edit")}
      canEditMetadata={p("scene:rename")}
      canEditRehearsalMark={p("rehearsal_mark:create")}
      canImport={p("script:import")}
      versionId={versionId}
      initialSearchQuery={q}
    />
  );
}
