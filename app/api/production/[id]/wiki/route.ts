import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { listWikiLibrary, createWiki, searchWiki, ensureDramaturgyRootAnchor } from "@/lib/wiki-db";
import {
  listVisibleWikiIds, listEnumerableWikiIds, canPlaceWikiUnder, canWriteWikiContainer,
} from "@/lib/wiki-perm";

type Ctx = { params: Promise<{ id: string }> };

// GET  /api/production/[id]/wiki[?q=]   文档库列表（树平铺）/ 搜索
// POST /api/production/[id]/wiki        创建文档（门：node:wiki/*@create）
//
// 两个面走两个门（#357）：
//   树列表 → 枚举面 listEnumerableWikiIds（能不能在目录里列到）
//   搜索   → 内容面 listVisibleWikiIds（能不能读）——**不得改用枚举面**：按标题搜
//            闭包外的文档就是枚举面的后门，反复搜即枚举。`[[` 补全走的正是这个
//            分支（components/SmartTextarea.tsx），候选集永远不得超出内容可读集。

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const q = req.nextUrl.searchParams.get("q");
  if (q) {
    const [visible, hits] = await Promise.all([
      listVisibleWikiIds(actor, productionId),
      searchWiki(productionId, q),
    ]);
    return Response.json({
      results: visible.wildcard ? hits : hits.filter(h => visible.ids.has(h.id)),
    });
  }
  const [enumerable, all] = await Promise.all([
    listEnumerableWikiIds(actor, productionId),
    listWikiLibrary(productionId),
  ]);
  const wikis = enumerable.wildcard ? all : all.filter(w => enumerable.ids.has(w.id));
  return Response.json({ wikis });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as {
    title?: string; body?: string; parentId?: string | null;
    /** 可枚举性（#357），缺省 true。false＝建在目录里但只有被显式分享的人能列到。 */
    listable?: boolean;
    /** 显式 parentId 缺席时的落位锚点。锚点可能尚未建（懒建），由服务端在**过完
     *  create 门之后**补建——ensure 是写事务，渲染路径一律不准碰。 */
    parentAnchor?: "dramaturgy";
  };
  if (!body.title?.trim()) return Response.json({ error: "标题不能为空" }, { status: 400 });

  // 落位双门（#357 症状⑤）。与移动同门——否则"无权移入就改为在目标父下新建"
  // 是条后门。
  //
  // 门必须跑在 ensureDramaturgyRootAnchor **之前**：那是个写事务，会凭空建一篇
  // wiki，让它成为一个最终被 403 的请求的副作用是 write-before-authz（AI review
  // 二轮 #1）。所以只对**显式父**判定；锚点路径不判——不是跳过检查，是两道门在
  // 锚点上恒真且可静态论证：锚点 is_public + listable 默认真 + 挂顶层 ⇒ ① 恒真；
  // isWikiAnchor 分支 ⇒ ② 恒真。配置关闭时 ensure 返回 null＝落顶层，同样无门。
  const explicitParentId = body.parentId?.trim() || null;
  if (explicitParentId) {
    if (!await canPlaceWikiUnder(actor, productionId, explicitParentId))
      return Response.json({ error: "无权在该父文档下创建" }, { status: 403 });
    if (!await canWriteWikiContainer(actor, productionId, explicitParentId))
      return Response.json({ error: "无权修改该父文档的子目录" }, { status: 403 });
  }

  const parentId = explicitParentId
    ?? (body.parentAnchor === "dramaturgy" ? await ensureDramaturgyRootAnchor(productionId) : null);

  try {
    const wiki = await createWiki({
      productionId,
      title: body.title.trim(),
      body: body.body ?? "",
      parentId,
      listable: body.listable ?? true,
      createdBy: session.userId,
    });
    return Response.json({ wiki }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "创建失败" }, { status: 400 });
  }
}
