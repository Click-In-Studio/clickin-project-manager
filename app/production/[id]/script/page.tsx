import type { Metadata } from "next";
export const metadata: Metadata = { title: "剧本" };

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { canViewScriptBlocks, scriptBlocksUnauthorizedUrl } from "@/lib/script/script-perm";
import { getSceneFieldPerms } from "@/lib/script/scene-field-perms";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getProductionName } from "@/lib/production/production-db";
import { getMasterScriptViewId } from "@/lib/script/script-view-db";
import { getActiveVersionId } from "@/lib/script/version-db";
import { loadScriptWindowBootstrap } from "@/lib/script/script-window-db";
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
  const [sceneFieldPerms, masterViewId, activeVersionId, canEditText, canEditRehearsalMark] =
    await Promise.all([
      getSceneFieldPerms(session.userId, id, access.permCtx.isAdmin || access.permCtx.isOwner),
      getMasterScriptViewId(id),
      // 活跃版本随页面一起下发：客户端首个请求就带 ?v=，不必等回包再整本重拉一遍。
      getActiveVersionId(id),
      hasEffectiveGrant(access.permCtx, id, "script", "*", "blocks", "edit"),
      hasEffectiveGrant(access.permCtx, id, "script", "*", "rehearsal_marks", "create"),
    ]);

  // 恢复位置在首窗查询前解析：避免先下发开头 240 块，hydration 后再跳到上次位置。
  // hash 不会随 HTTP 请求到服务端，block 深链仍由客户端在 hydration 后提到最高优先级。
  const savedPosition = cookieStore.get(`script_pos_${id}`)?.value;
  let initialWindowStart = 0;
  if (savedPosition) {
    const decoded = decodeURIComponent(savedPosition);
    const colonAt = decoded.lastIndexOf(":");
    const savedIndex = colonAt > 0 ? Number(decoded.slice(colonAt + 1)) : NaN;
    if (Number.isFinite(savedIndex)) initialWindowStart = Math.max(0, Math.floor(savedIndex) - 80);
  }
  const initialWindow = activeVersionId
    ? await loadScriptWindowBootstrap(id, activeVersionId, initialWindowStart, 240)
    : null;

  return (
    <>
      <ScriptEditor
        productionId={id}
        productionName={name ?? undefined}
        canEditText={canEditText}
        canEditMetadata={sceneFieldPerms.any}
        canEditLayout={await hasEffectiveGrant(access.permCtx, id, "script_view", masterViewId ?? "*", "*", "edit")}
        canEditRehearsalMark={canEditRehearsalMark}
        initialSearchQuery={q}
        initialVersionId={activeVersionId}
        initialWindow={initialWindow}
      />
      <PageActivationGate productionId={id} scope="script" />
    </>
  );
}
