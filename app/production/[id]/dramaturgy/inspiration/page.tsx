import type { Metadata } from "next";
export const metadata: Metadata = { title: "构作 · 灵感文档" };

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getProductionName, getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { ensureDramaturgyRootAnchor, listWikiLibrary } from "@/lib/wiki-db";
import { listVisibleWikiIds } from "@/lib/wiki-perm";
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
  const rootId = await ensureDramaturgyRootAnchor(productionId);
  const [all, visible, canCreate] = await Promise.all([
    listWikiLibrary(productionId),
    listVisibleWikiIds(actor, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);
  const allowed = visible.wildcard ? all : all.filter((wiki) => visible.ids.has(wiki.id));
  const wikis = listDramaturgyWikiSubtree(allowed, rootId);
  const routeBase = `/production/${productionId}/dramaturgy/inspiration`;

  return (
    <>
      <DramaturgyInspirationShell productionId={productionId} productionName={productionName}>
        <WikiShell
          productionId={productionId}
          wikis={wikis}
          canCreate={canCreate && !!rootId}
          navigationBasePath={routeBase}
          rootParentId={rootId ?? undefined}
        >
          <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--surface)]/60 px-8 text-center">
            <p className="text-sm text-[var(--muted)]">
              {!rootId
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
