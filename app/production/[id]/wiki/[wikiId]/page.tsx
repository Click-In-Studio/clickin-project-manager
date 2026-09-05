import type { Metadata } from "next";
export const metadata: Metadata = { title: "知识库" };

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listProductionMembers } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getWiki } from "@/lib/wiki/content";
import { getAsset } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import AssetPreviewClient from "@/components/assets/AssetPreviewClient";
import { listBacklinks, listUnlinkedReferences, listEntityRefsForWiki } from "@/lib/wiki/links";
import { canViewWiki, canEditWiki, canShareWiki } from "@/lib/wiki/perm";
import { listNodeTreeFor } from "@/lib/node/tree-view";
import { getNode } from "@/lib/node/db";
import { listEventDepartments } from "@/lib/event-db";
import PageHeader from "@/components/PageHeader";
import PageActivationGate from "@/components/PageActivationGate";
import WikiShell from "@/components/wiki/WikiShell";
import WikiDocClient from "@/components/wiki/WikiDocClient";

export default async function WikiDocPage({ params }: { params: Promise<{ id: string; wikiId: string }> }) {
  const { id: productionId, wikiId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [access, productionName] = await Promise.all([
    getProductionPermissionContext(session.userId, session.isAdmin, productionId),
    getProductionName(productionId),
  ]);
  if (!access) redirect(`/unauthorized?id=${productionId}`);
  if (!productionName) notFound();
  const actor = toActor(session, access.permCtx);

  // 路由段可能是 **`nd_` 节点 id**（#358 → #420）：软链接或资产壳节点；真实文档
  // 是 UUID，一眼可辨，同一路由段分派。link/asset 都**就地渲染**——302 到目标会
  // 把人弹出作用域化工作区（#352）。权限判定一律落到目标上：link 一票不投。
  const isNodeSegment = wikiId.startsWith("nd_");
  const segNode = isNodeSegment ? await getNode(wikiId, productionId) : null;
  if (isNodeSegment && (!segNode
      || (segNode.kind !== "link" && segNode.kind !== "asset")
      || (segNode.kind === "link" && !segNode.linkTargetId))) notFound();
  const linkTarget = segNode?.kind === "link" && segNode.linkTargetId
    ? await getNode(segNode.linkTargetId, productionId) : null;
  if (segNode?.kind === "link" && !linkTarget) notFound();

  // 资产节点（直达或经 link）→ 内嵌资产预览（#420 第二批：树内不出工作区）
  const assetNode = segNode?.kind === "asset" ? segNode
    : linkTarget?.kind === "asset" ? linkTarget : null;
  if (assetNode?.assetId) {
    const asset = await getAsset(assetNode.assetId);
    if (!asset || asset.productionId !== productionId) notFound();
    const [{ nodes }, canCreate] = await Promise.all([
      listNodeTreeFor(actor, productionId),
      hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
    ]);
    const canView = await canViewAsset(access.permCtx, productionId, asset, "meta");
    return (
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Wiki" title="知识库" side="stage" />
        <WikiShell productionId={productionId} nodes={nodes} canCreate={canCreate} selectedId={wikiId} myUserId={session.userId} canManageAssets={access.permCtx.isAdmin || access.permCtx.isOwner}>
          {canView ? (
            <AssetPreviewClient
              productionId={productionId}
              assetId={asset.id}
              versionId={null}
              fileName={asset.name ?? asset.fileName}
              mimeType={asset.mimeType}
              storageType={asset.storageType}
              feishuUrl={asset.feishuUrl}
              userName={session.name}
              variant="embedded"
            />
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-white px-8 flex flex-col items-center justify-center text-center">
              <p className="text-lg font-bold text-zinc-800 mb-1">{asset.name ?? asset.fileName}</p>
              <p className="text-sm text-zinc-400 mb-6">你没有这个资产的查看权限</p>
              <Link
                href={`/unauthorized?resource=${encodeURIComponent("node:asset/*/meta@view")}&id=${productionId}`}
                className="inline-block rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2 text-xs font-bold text-white"
              >
                申请访问
              </Link>
            </div>
          )}
        </WikiShell>
      </div>
    );
  }
  const docId = linkTarget?.wikiId ?? wikiId;

  const wiki = await getWiki(docId, productionId);
  if (!wiki) notFound();

  // 侧栏树＝枚举面；正文＝内容面（canViewWiki）。当前文档可能不在自己的枚举闭包里
  // （经 wikilink / 挂载边到达的可读文档），此时树里没有它、无高亮——这是 B 语义
  // 的正常状态，不是 bug。闭包外可读文档的独立入口是 #357 的 follow-up。
  const [{ nodes }, canCreate] = await Promise.all([
    listNodeTreeFor(actor, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);

  const canView = await canViewWiki(actor, productionId, docId);
  if (!canView) {
    // §4.1：标题=目录级信息（持有链接/id 即可见标题），内容过权限门 → 申请入口
    const applyResource = `node:wiki/${docId}@view`;
    return (
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Wiki" title="知识库" side="stage" />
        <WikiShell productionId={productionId} nodes={nodes} canCreate={canCreate} selectedId={wikiId} myUserId={session.userId} canManageAssets={access.permCtx.isAdmin || access.permCtx.isOwner}>
          <div className="rounded-xl border border-zinc-200 bg-white px-8 flex flex-col items-center justify-center text-center">
            <p className="text-lg font-bold text-zinc-800 mb-1">[[{wiki.title ?? "（无标题）"}]]</p>
            <p className="text-sm text-zinc-400 mb-6">你没有这篇文档的阅读权限</p>
            <Link
              href={`/unauthorized?resource=${encodeURIComponent(applyResource)}&id=${productionId}`}
              className="inline-block rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2 text-xs font-bold text-white"
            >
              申请访问
            </Link>
          </div>
        </WikiShell>
      </div>
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
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Wiki" title="知识库" side="stage" />
        <WikiShell productionId={productionId} nodes={nodes} canCreate={canCreate} selectedId={wikiId} myUserId={session.userId} canManageAssets={access.permCtx.isAdmin || access.permCtx.isOwner}>
          <WikiDocClient
            productionId={productionId}
            wiki={wiki}
            canEdit={canEdit}
            canShare={canShare}
            members={members.map(m => ({ userId: m.userId, name: m.name, avatarUrl: m.avatarUrl }))}
            departments={allDepts.filter(d => d.kind === "dept").map(d => ({ id: d.id, name: d.name }))}
            backlinks={backlinks}
            unlinked={unlinked}
            entityRefs={entityRefs}
          />
        </WikiShell>
      </div>
      <PageActivationGate productionId={productionId} scope="wiki" />
    </>
  );
}
