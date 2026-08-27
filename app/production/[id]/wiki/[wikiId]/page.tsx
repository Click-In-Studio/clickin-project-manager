import type { Metadata } from "next";
export const metadata: Metadata = { title: "文档" };

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, listProductionMembers } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getWiki, listWikiLibrary, listBacklinks, listUnlinkedReferences, listEntityRefsForWiki } from "@/lib/wiki-db";
import { canViewWiki, canEditWiki, canShareWiki, listEnumerableWikiIds } from "@/lib/wiki-perm";
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

  const wiki = await getWiki(wikiId, productionId);
  if (!wiki) notFound();

  // 侧栏树＝枚举面；正文＝内容面（canViewWiki）。当前文档可能不在自己的枚举闭包里
  // （经 wikilink / 挂载边到达的可读文档），此时树里没有它、无高亮——这是 B 语义
  // 的正常状态，不是 bug。闭包外可读文档的独立入口是 #357 的 follow-up。
  const [all, enumerable, canCreate] = await Promise.all([
    listWikiLibrary(productionId),
    listEnumerableWikiIds(actor, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);
  const wikis = enumerable.wildcard ? all : all.filter(w => enumerable.ids.has(w.id));

  const canView = await canViewWiki(actor, productionId, wikiId);
  if (!canView) {
    // §4.1：标题=目录级信息（持有链接/id 即可见标题），内容过权限门 → 申请入口
    const applyResource = `node:wiki/${wikiId}@view`;
    return (
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Wiki" title="文档" side="stage" />
        <WikiShell productionId={productionId} wikis={wikis} canCreate={canCreate} selectedId={wikiId}>
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
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Wiki" title="文档" side="stage" />
        <WikiShell productionId={productionId} wikis={wikis} canCreate={canCreate} selectedId={wikiId}>
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
