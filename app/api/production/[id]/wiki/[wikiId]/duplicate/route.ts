import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { duplicateWiki } from "@/lib/wiki/content";
import { canViewWiki } from "@/lib/wiki/perm";
import { canPlaceNodeUnder, canWriteNodeContainer } from "@/lib/node/perm";
import { getNodeByWikiId } from "@/lib/node/db";

type Ctx = { params: Promise<{ id: string; wikiId: string }> };

// POST /api/production/[id]/wiki/[wikiId]/duplicate   创建副本（#511）
//
// 三道门，缺一是后门：
//   · 读原件（canViewWiki）——正文要抄过去，读不到就不能抄；
//   · 建文档（node:wiki/*@create）——副本就是一篇新建；
//   · 落位双门（同 POST /wiki 与移动）——副本落在原件旁边＝在原件的父下新建，
//     否则"无权在此新建就复制一份放这儿"是绕过落位门。
// 都过了才写；三门全跑在 duplicateWiki 之前（write-before-authz 不许）。存在性
// 与父 id 只查壳节点（不带正文），正文由 duplicateWiki 在门后才读。

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const node = await getNodeByWikiId(wikiId);
  if (!node || node.productionId !== productionId)
    return Response.json({ error: "文档不存在" }, { status: 404 });
  if (!await canViewWiki(actor, productionId, wikiId))
    return Response.json({ error: "无权访问该文档" }, { status: 403 });
  if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (!await canPlaceNodeUnder(actor, productionId, node.parentId))
    return Response.json({ error: "无权在该父文档下创建" }, { status: 403 });
  if (!await canWriteNodeContainer(actor, productionId, node.parentId))
    return Response.json({ error: "无权修改该父文档的子目录" }, { status: 403 });

  try {
    const wiki = await duplicateWiki(wikiId, productionId, session.userId);
    if (!wiki) return Response.json({ error: "文档不存在" }, { status: 404 });
    return Response.json({ wiki }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "创建副本失败" }, { status: 400 });
  }
}
