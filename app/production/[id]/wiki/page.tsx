import type { Metadata } from "next";
export const metadata: Metadata = { title: "文档" };

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { listWikiTreeFor } from "@/lib/wiki-tree";
import PageHeader from "@/components/PageHeader";
import PageActivationGate from "@/components/PageActivationGate";
import WikiShell from "@/components/wiki/WikiShell";

export default async function WikiLibraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await params;
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

  // 树＝枚举面（#357）+ 软链接别名（#358）。枚举集是含根的连通子树，投影到
  // parent_id 上不会有断链；别名另有自己的判定式，两者都收在 listWikiTreeFor 里。
  const [{ wikis, aliases }, canCreate] = await Promise.all([
    listWikiTreeFor(actor, productionId),
    hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"),
  ]);

  return (
    <>
      <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
        <PageHeader eyebrow="Wiki" title="文档" side="stage" />
        <WikiShell productionId={productionId} wikis={wikis} aliases={aliases} canCreate={canCreate}>
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white/60 px-8 flex items-center justify-center">
            <p className="text-sm text-zinc-400">
              {wikis.length > 0 ? "从左侧选择一篇文档" : canCreate ? "还没有文档，从左侧新建一篇" : "还没有你可见的文档"}
            </p>
          </div>
        </WikiShell>
      </div>
      <PageActivationGate productionId={productionId} scope="wiki" />
    </>
  );
}
