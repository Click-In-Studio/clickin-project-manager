import type { Metadata } from "next";
export const metadata: Metadata = { title: "构作 · 灵感文档" };

import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import {
  getProductionName,
  getProductionPermissionContext,
  listProductionMembers,
} from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import {
  ensureDramaturgyRootAnchor,
  getWiki,
  listBacklinks,
  listEntityRefsForWiki,
  listUnlinkedReferences,
  listWikiLibrary,
} from "@/lib/wiki-db";
import {
  canEditWiki,
  canShareWiki,
  canViewWiki,
  listVisibleWikiIds,
} from "@/lib/wiki-perm";
import { listEventDepartments } from "@/lib/event-db";
import { listDramaturgyWikiSubtree } from "@/lib/dramaturgy-wiki";
import { DramaturgyInspirationShell } from "@/components/DramaturgyWorkspaceTabs";
import WikiShell from "@/components/wiki/WikiShell";
import WikiDocClient from "@/components/wiki/WikiDocClient";
import PageActivationGate from "@/components/PageActivationGate";

export default async function DramaturgyInspirationDocPage({
  params,
}: {
  params: Promise<{ id: string; wikiId: string }>;
}) {
  const { id: productionId, wikiId } = await params;
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
  if (!rootId) notFound();

  const [wiki, all, visible, canCreate] = await Promise.all([
    getWiki(wikiId, productionId),
    listWikiLibrary(productionId),
    listVisibleWikiIds(actor, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);
  if (!wiki) notFound();

  const fullSubtree = listDramaturgyWikiSubtree(all, rootId);
  if (!fullSubtree.some((entry) => entry.id === wikiId)) notFound();

  const allowed = visible.wildcard ? all : all.filter((entry) => visible.ids.has(entry.id));
  const wikis = listDramaturgyWikiSubtree(allowed, rootId);
  const routeBase = `/production/${productionId}/dramaturgy/inspiration`;
  const canView = await canViewWiki(actor, productionId, wikiId);

  if (!canView) {
    const applyResource = `node:wiki/${wikiId}@view`;
    return (
      <DramaturgyInspirationShell productionId={productionId} productionName={productionName}>
        <WikiShell
          productionId={productionId}
          wikis={wikis}
          canCreate={canCreate}
          selectedId={wikiId}
          navigationBasePath={routeBase}
          rootParentId={rootId}
        >
          <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface)] px-8 text-center">
            <p className="mb-1 text-lg font-bold text-[var(--ink)]">[[{wiki.title ?? "（无标题）"}]]</p>
            <p className="mb-6 text-sm text-[var(--muted)]">你没有这篇文档的阅读权限</p>
            <Link
              href={`/unauthorized?resource=${encodeURIComponent(applyResource)}&id=${productionId}`}
              className="inline-block rounded-lg border border-[var(--ink)] bg-[var(--ink)] px-4 py-2 text-xs font-bold text-white"
            >
              申请访问
            </Link>
          </div>
        </WikiShell>
      </DramaturgyInspirationShell>
    );
  }

  const [canEdit, canShare, backlinks, unlinked, entityRefs, members, allDepts] = await Promise.all([
    canEditWiki(actor, productionId, wikiId),
    canShareWiki(actor, productionId, wikiId),
    listBacklinks(wikiId, productionId),
    listUnlinkedReferences(wikiId, productionId),
    listEntityRefsForWiki(wikiId, productionId),
    listProductionMembers(productionId),
    listEventDepartments(productionId),
  ]);

  return (
    <>
      <DramaturgyInspirationShell productionId={productionId} productionName={productionName}>
        <WikiShell
          productionId={productionId}
          wikis={wikis}
          canCreate={canCreate}
          selectedId={wikiId}
          navigationBasePath={routeBase}
          rootParentId={rootId}
        >
          <WikiDocClient
            productionId={productionId}
            wiki={wiki}
            canEdit={canEdit}
            canShare={canShare}
            members={members.map((member) => ({
              userId: member.userId,
              name: member.name,
              avatarUrl: member.avatarUrl,
            }))}
            departments={allDepts
              .filter((department) => department.kind === "dept")
              .map((department) => ({ id: department.id, name: department.name }))}
            backlinks={backlinks}
            unlinked={unlinked}
            entityRefs={entityRefs}
            navigationBasePath={routeBase}
          />
        </WikiShell>
      </DramaturgyInspirationShell>
      <PageActivationGate productionId={productionId} scope="wiki" />
    </>
  );
}
