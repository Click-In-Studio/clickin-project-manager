import type { Metadata } from "next";
export const metadata: Metadata = { title: "剧本" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { getSceneFieldPerms } from "@/lib/scene-field-perms";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import ScriptEditor from "@/components/ScriptEditor";
import PageActivationGate from "@/components/PageActivationGate";

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
  if (!access.permCtx.isAdmin && !access.permCtx.isOwner && !await hasGrant(session.userId, id, "script", "*", "blocks", "view"))
    redirect(`/unauthorized?resource=node%3Ascript%2F*%2Fblocks%40view&id=${id}`);

  // scene 已拆到字段级门（lib/scene-field-perms）：canEditMetadata 是「值得显示
  // 编辑态」的粗门，紧凑排版/config PUT 单独看 meta/name@edit。
  const sceneFieldPerms = await getSceneFieldPerms(
    session.userId, id, access.permCtx.isAdmin || access.permCtx.isOwner,
  );

  // Resolve initial version: URL param > cookie
  const versionId = v ?? cookieStore.get(`ver_${id}`)?.value ?? null;

  return (
    <>
      <ScriptEditor
        productionId={id}
        productionName={name ?? undefined}
        canEditText={access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(session.userId, id, "script", "*", "blocks", "edit")}
        canEditMetadata={sceneFieldPerms.any}
        canEditSceneName={sceneFieldPerms.name}
        canEditRehearsalMark={access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(session.userId, id, "script", "*", "rehearsal_marks", "create")}
        canImport={access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(session.userId, id, "script", "*", "imports", "create")}
        versionId={versionId}
        initialSearchQuery={q}
      />
      <PageActivationGate productionId={id} scope="script" />
    </>
  );
}
