import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getProductionName, getUserPrimaryEmail } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getWiki } from "@/lib/wiki/content";
import { canViewWiki } from "@/lib/wiki/perm";
import WikiPrintPage from "@/components/wiki/WikiPrintPage";

export const metadata: Metadata = { title: "打印文档" };

/**
 * wiki 打印路由（#335）：/production/[id]/wiki/[wikiId]/print
 *
 * 从 WikiDocClient 里的 overlay 搬出来，理由与剧本打印页相同：打印要有 URL。
 * 另外它顺手补上了一个漏洞——overlay 版本**完全没有水印**：全页水印节点挂在
 * document.body 直下，恰好被 globals.css 的
 * `body:has(.wiki-print-root) > *:not(.wiki-print-root)` 一起隐藏了，
 * 于是 wiki 导出的 PDF 是裸奔的。
 *
 * 权限门与 /production/[id]/wiki/[wikiId] 一致：能读文档才能打印文档。
 */
export default async function WikiPrintRoutePage({
  params,
}: {
  params: Promise<{ id: string; wikiId: string }>;
}) {
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

  const wiki = await getWiki(wikiId, productionId);
  if (!wiki) notFound();

  // 标题是目录级信息，但正文过权限门——打印页给的是正文，所以无权即挡，
  // 不走文档页那条「显示标题 + 申请入口」的降级分支。
  if (!(await canViewWiki(toActor(session, access.permCtx), productionId, wikiId))) {
    redirect(`/unauthorized?resource=node%3Awiki%2F${wikiId}%40view&id=${productionId}`);
  }

  // 水印文案服务端解析：客户端 fetch 有竞态，而水印是安全特性，
  // 不能取决于一次请求赢没赢。
  const email = await getUserPrimaryEmail(session.userId);
  const watermarkText = email ? `${session.name} ${email}` : session.name;

  return (
    <WikiPrintPage
      productionId={productionId}
      productionName={productionName}
      wikiId={wikiId}
      title={wiki.title || "文档"}
      body={wiki.body}
      updatedAt={wiki.updatedAt}
      watermarkText={watermarkText}
    />
  );
}
