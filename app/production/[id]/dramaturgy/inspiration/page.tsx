import type { Metadata } from "next";
export const metadata: Metadata = { title: "构作 · 灵感文档" };

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getProductionName, getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getDramaturgyTreeConfig, listWikiLibrary } from "@/lib/wiki-db";
import { listEnumerableWikiIds } from "@/lib/wiki-perm";
import { listDramaturgyWikiSubtree } from "@/lib/dramaturgy-wiki";
import { DramaturgyInspirationShell } from "@/components/DramaturgyWorkspaceTabs";
import WikiShell from "@/components/wiki/WikiShell";
import PageActivationGate from "@/components/PageActivationGate";

export default async function DramaturgyInspirationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: productionId } = await params;
  const session = getSession(await cookies());
  if (!session) redirect("/login");

  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    getProductionName(productionId),
  ]);
  if (!access) redirect(`/unauthorized?id=${productionId}`);
  if (!productionName) notFound();

  const actor = toActor(session, access.permCtx);
  const [treeConfig, all, enumerable, canCreate] = await Promise.all([
    getDramaturgyTreeConfig(productionId),
    listWikiLibrary(productionId),
    listEnumerableWikiIds(actor, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);
  // 锚点是懒建的：enabled 但 rootWikiId 仍为 null＝还没人建过第一篇，属正常空态
  // （新建走 parentAnchor，服务端在 create 门后补建根）。
  const rootId = treeConfig.enabled ? treeConfig.rootWikiId : null;
  // 子树成员在**全量**上算，再过枚举面（#357）。枚举集是含根的连通子树，所以
  // 过滤后的结果照样连通——#352 那次「父不可见、子可见 → 整篇消失」的断链根因
  // 已在判定层消解，这里的先后顺序不再是正确性前提（保持全量算子树是为了
  // 越界判定与侧栏同源）。
  const subtree = listDramaturgyWikiSubtree(all, rootId);
  const wikis = enumerable.wildcard ? subtree : subtree.filter((wiki) => enumerable.ids.has(wiki.id));
  const routeBase = `/production/${productionId}/dramaturgy/inspiration`;

  return (
    <>
      <DramaturgyInspirationShell productionId={productionId} productionName={productionName}>
        <WikiShell
          productionId={productionId}
          wikis={wikis}
          canCreate={canCreate && treeConfig.enabled}
          navigationBasePath={routeBase}
          rootParentId={rootId ?? undefined}
          rootAnchor="dramaturgy"
        >
          <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--surface)]/60 px-8 text-center">
            <p className="text-sm text-[var(--muted)]">
              {!treeConfig.enabled
                ? "当前项目未启用构作灵感文档"
                : wikis.length > 0
                  ? "从左侧选择一篇灵感文档"
                  : canCreate
                    ? "还没有灵感文档，从左侧新建一篇"
                    : "还没有你可见的灵感文档"}
            </p>
          </div>
        </WikiShell>
      </DramaturgyInspirationShell>
      <PageActivationGate productionId={productionId} scope="wiki" />
    </>
  );
}
