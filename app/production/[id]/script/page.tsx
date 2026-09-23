import type { Metadata } from "next";
export const metadata: Metadata = { title: "剧本" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { canViewScriptBlocks, scriptBlocksUnauthorizedUrl } from "@/lib/script/script-perm";
import { getSceneFieldPerms } from "@/lib/script/scene-field-perms";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { getMasterScriptViewId } from "@/lib/script/script-view-db";
import { getActiveVersionId } from "@/lib/script/version-db";
import ScriptEditor from "@/components/script/ScriptEditor";
import PageActivationGate from "@/components/perm/PageActivationGate";

export default async function ProductionScriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, name] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, id),
    getProductionName(id),
  ]);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (!(await canViewScriptBlocks(access.permCtx, id)))
    redirect(scriptBlocksUnauthorizedUrl(id));

  // 门与初值一轮并发拿完（#641）：逐个 await 就是逐个 DB 往返串起来，全在 TTFB 里。
  // canEditLayout 要等 masterViewId，所以留在第二轮。
  // scene 已拆到字段级门（lib/script/scene-field-perms）：canEditMetadata 是「值得显示
  // 编辑态」的粗门，紧凑排版/config PUT 单独看 meta/name@edit。
  const [sceneFieldPerms, masterViewId, activeVersionId, canEditText, canEditRehearsalMark, canImport] =
    await Promise.all([
      getSceneFieldPerms(session.userId, id, access.permCtx.isAdmin || access.permCtx.isOwner),
      getMasterScriptViewId(id),
      // 活跃版本随页面一起下发：客户端首个请求就带 ?v=，不必等回包再整本重拉一遍。
      getActiveVersionId(id),
      hasEffectiveGrant(access.permCtx, id, "script", "*", "blocks", "edit"),
      hasEffectiveGrant(access.permCtx, id, "script", "*", "rehearsal_marks", "create"),
      hasEffectiveGrant(access.permCtx, id, "script", "*", "imports", "create"),
    ]);

  return (
    <>
      <ScriptEditor
        productionId={id}
        productionName={name ?? undefined}
        canEditText={canEditText}
        canEditMetadata={sceneFieldPerms.any}
        canEditLayout={await hasEffectiveGrant(access.permCtx, id, "script_view", masterViewId ?? "*", "*", "edit")}
        canEditRehearsalMark={canEditRehearsalMark}
        canImport={canImport}
        initialSearchQuery={q}
        initialVersionId={activeVersionId}
      />
      <PageActivationGate productionId={id} scope="script" />
    </>
  );
}
