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
import { getDramaturgyTreeConfig } from "@/lib/node/anchors";
import { getWiki } from "@/lib/wiki/content";
import { listBacklinks, listEntityRefsForWiki, listUnlinkedReferences } from "@/lib/wiki/links";
import { canEditWiki, canShareWiki, canViewWiki } from "@/lib/wiki/perm";
import { listEventDepartments } from "@/lib/event-db";
import { getNode } from "@/lib/node/db";
import { listDramaturgyTreeFor } from "@/lib/node/tree-view";
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
  // 路由段可能是软链接节点（#358 → #420，`nd_` 短 id）：就地渲染目标正文，权限
  // 一律落到目标上；link 的「属于本工作区」由它自己的位置决定，与目标在哪无关。
  const isLinkSegment = wikiId.startsWith("nd_");
  const linkNode = isLinkSegment ? await getNode(wikiId, productionId) : null;
  if (isLinkSegment && (!linkNode || linkNode.kind !== "link" || !linkNode.linkTargetId)) notFound();
  const linkTarget = linkNode?.linkTargetId ? await getNode(linkNode.linkTargetId, productionId) : null;
  if (isLinkSegment && !linkTarget) notFound();
  if (linkTarget && linkTarget.kind === "asset" && linkTarget.assetId) {
    redirect(`/production/${productionId}/assets/${linkTarget.assetId}/preview`);
  }
  const docId = linkTarget?.wikiId ?? wikiId;

  const [treeConfig, wiki, canCreate] = await Promise.all([
    getDramaturgyTreeConfig(productionId),
    getWiki(docId, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);
  if (!wiki) notFound();

  // 成员判定与侧栏渲染同源：都在**全量**上算子树，再各自过枚举面（#357）。
  // 侧栏＝枚举面，正文＝内容面（canViewWiki）——两个门，别混。
  const rootId = treeConfig.enabled ? treeConfig.rootNodeId : null;
  const { subtree, nodes, moveIn } = await listDramaturgyTreeFor(actor, productionId, rootId);
  // 越界不是 404：工作区内的内链（[[…]]、反链）会指向子树外的文档，文档也可能
  // 在「文档」模块里被移出子树、或根锚点压根还没懒建。回落到通用 wiki 路由，
  // 别把人弹飞。别名同理——它是否在本工作区看位置，不看目标。
  const inWorkspace = linkNode
    ? nodes.some((n) => n.id === wikiId && n.kind === "link")
    : subtree.some((entry) => entry.wikiId === wikiId);
  if (!rootId || !inWorkspace) {
    redirect(`/production/${productionId}/wiki/${wikiId}`);
  }

  const routeBase = `/production/${productionId}/dramaturgy/inspiration`;
  const canView = await canViewWiki(actor, productionId, docId);

  if (!canView) {
    const applyResource = `node:wiki/${docId}@view`;
    return (
      <DramaturgyInspirationShell productionId={productionId} productionName={productionName}>
        <WikiShell
          myUserId={session.userId}
          canManageAssets={access.permCtx.isAdmin || access.permCtx.isOwner}
          productionId={productionId}
          nodes={nodes}
          moveInCandidates={moveIn}
          canCreate={canCreate}
          selectedId={wikiId}
          navigationBasePath={routeBase}
          rootParentId={rootId}
          rootAnchor="dramaturgy"
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
    canEditWiki(actor, productionId, docId),
    canShareWiki(actor, productionId, docId),
    listBacklinks(docId, productionId),
    listUnlinkedReferences(docId, productionId),
    listEntityRefsForWiki(docId, productionId),
    listProductionMembers(productionId),
    listEventDepartments(productionId),
  ]);

  return (
    <>
      <DramaturgyInspirationShell productionId={productionId} productionName={productionName}>
        <WikiShell
          myUserId={session.userId}
          canManageAssets={access.permCtx.isAdmin || access.permCtx.isOwner}
          productionId={productionId}
          nodes={nodes}
          moveInCandidates={moveIn}
          canCreate={canCreate}
          selectedId={wikiId}
          navigationBasePath={routeBase}
          rootParentId={rootId}
          rootAnchor="dramaturgy"
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
