import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import {
  getProductionPermissionContext,
  getActiveVersionId,
  loadProduction,
} from "@/lib/db";
import { buildMarkerContextById, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import ScriptPrintRoute from "@/components/print/ScriptPrintRoute";

export const metadata: Metadata = { title: "打印剧本" };

/**
 * 剧本打印路由（#335）：/production/[id]/script/print
 *
 * 与编辑器内的打印预览是同一套渲染，但这里有 URL——这是把打印从
 * ScriptEditor 内部 overlay 里搬出来的意义所在：可分享、可直达、
 * 将来可被无头浏览器打开。
 *
 * 挂在 script 之下而不是另起顶层前缀：打印的是「某个演出的剧本」，
 * 而且 AppShell / proxy 都按 /production/<id>/ 解析演出上下文，
 * 另起前缀会让所有按路径判定上下文的东西失效。
 *
 * 权限门与 /production/[id]/script 完全一致：能读剧本才能打印剧本。
 * 无 app shell 由 AppShell 对末段 /print 的旁路保证。
 */
export default async function ScriptPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) redirect(`/unauthorized?id=${id}`);
  if (
    !access.permCtx.isAdmin &&
    !access.permCtx.isOwner &&
    !(await hasGrant(session.userId, id, "script", "*", "blocks", "view"))
  ) {
    redirect(`/unauthorized?resource=node%3Ascript%2F*%2Fblocks%40view&id=${id}`);
  }

  // 版本分叉已退役（PR #300），只有 head——所以 URL 契约里不带版本参数。
  const versionId = await getActiveVersionId(id);
  if (!versionId) notFound();
  const loaded = await loadProduction(id, versionId);
  if (!loaded) notFound();

  const { blocks, characters, scenes, config } = loaded.state;
  // 与编辑器同一条投影链（marker 归属 → legacy 投影）。分页吃的是投影后的块，
  // 两边不一致会直接变成「屏上分页与纸上分页不同」。
  const owned = withMarkerOwnership(blocks);
  const projected = withLegacyOwnershipProjection(owned, buildMarkerContextById(owned));

  return (
    <ScriptPrintRoute
      productionId={id}
      blocks={projected}
      characters={characters}
      scenes={scenes}
      config={config}
    />
  );
}
