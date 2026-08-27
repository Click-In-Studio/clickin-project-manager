import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getWiki, updateWiki, deleteWiki } from "@/lib/wiki-db";
import {
  canViewWiki, canEditWiki, canDeleteWiki, canShareWiki,
  canPlaceWikiUnder, canWriteWikiContainer,
} from "@/lib/wiki-perm";
import { broadcastWikiUpdate } from "@/lib/wiki-collab";
import { readParentAnchor } from "@/lib/wiki-input";
import { gateAndResolveWikiAnchor } from "@/lib/wiki-placement";
import type { Mention } from "@/lib/event-db";
import { setWikiPublic, setWikiListable, type WikiPlacement } from "@/lib/wiki-db";

type Ctx = { params: Promise<{ id: string; wikiId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const wiki = await getWiki(wikiId, productionId);
  if (!wiki) return Response.json({ error: "文档不存在" }, { status: 404 });
  if (!await canViewWiki(actor, productionId, wikiId)) {
    // §4.1：标题=目录级信息（引用持有者可见），内容 403 附申请锚
    return Response.json({
      error: "无权访问该文档",
      title: wiki.title,
      applyResource: `node:wiki/${wikiId}@view`,
    }, { status: 403 });
  }
  const canEdit = await canEditWiki(actor, productionId, wikiId);
  const canShare = await canShareWiki(actor, productionId, wikiId);
  return Response.json({ wiki, canEdit, canShare });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const existing = await getWiki(wikiId, productionId);
  if (!existing) return Response.json({ error: "文档不存在" }, { status: 404 });

  const body = await req.json() as {
    title?: string; body?: string; mentions?: Mention[];
    parentId?: string | null; sortKey?: string; tags?: string[];
    /** 显式 parentId 缺席时的落位锚点（#355 移入）。语义与 POST /wiki 同：锚点
     *  可能尚未懒建，由服务端在**过完门之后**补建。 */
    parentAnchor?: "dramaturgy";
    /** 相对锚点落位（#357 症状②）：客户端只说"放在谁的前/后"，服务端在完整
     *  兄弟集上算键——可枚举性逐节点后客户端兄弟集可能有空洞。 */
    place?: WikiPlacement;
    isPublic?: boolean;
    /** 可枚举性开关（#357）——与 isPublic 同属分享面 */
    listable?: boolean;
    /** 协作：客户端上次确认的服务端正文——与库中现值不同时做行级三路合并 */
    baseBody?: string;
    /** 协作：发起端 SSE clientId（广播自过滤） */
    clientId?: string;
  };

  const wantsContent = body.title !== undefined || body.body !== undefined
    || body.mentions !== undefined || body.parentId !== undefined
    || body.parentAnchor !== undefined
    || body.sortKey !== undefined || body.place !== undefined || body.tags !== undefined;
  if (wantsContent && !await canEditWiki(actor, productionId, wikiId))
    return Response.json({ error: "权限不足" }, { status: 403 });
  // 公开/可枚举开关属分享面（grants@edit 保留段）
  if ((body.isPublic !== undefined || body.listable !== undefined)
      && !await canShareWiki(actor, productionId, wikiId))
    return Response.json({ error: "权限不足（分享面）" }, { status: 403 });

  // 字段校验夹在授权与 ensure 之间，位置是两头顶死的：授权在前（403 优先于 400，
  // AI review #1），ensureDramaturgyRootAnchor 在后（它是写事务，一个最终 400 的
  // 请求不该凭空建出一篇根文档）。
  if (body.title !== undefined && !body.title.trim())
    return Response.json({ error: "标题不能为空" }, { status: 400 });
  const anchor = readParentAnchor(body.parentAnchor);
  if (!anchor.ok) return Response.json({ error: "未知的落位锚点" }, { status: 400 });

  // 落位/重排门（#357 症状⑤）。三道：
  //   ① 目标父可枚举（枚举面）——不往自己列不出的容器里塞东西
  //   ② 目标父容器可写（写面）——增删/重排子项是对**容器**的改动
  //   ③ 换父时源父也要容器可写——否则"把它从别人的子树里挪走"照旧成立
  // 重排（place/sortKey）等同对当前父的子项改动，①② 都过——列不出的容器谈不上
  // "重排它的子项"（该容器的子项对你本来就不可枚举），403 是正确答案而非误伤。
  // ③ 只在真的换父时才有意义，故额外要 targetParentId !== existing.parentId。
  //
  // 锚点落位（#355 移入）：灵感库根可能尚未懒建，此时客户端给的是 parentAnchor 而
  // 不是 parentId，目标父 id 要等解析完才知道。①② 因此交给
  // gateAndResolveWikiAnchor——它在**已存在的根**上照常跑这两道，只在根是它当场
  // 新建时才用恒真论证（见那边的头注释）。③（源父容器可写）与目标无关，照跑。
  // parentId 与 parentAnchor 同送时锚点胜（`parentId: null` 与"字段缺席"在这里
  // collapse 成同一个 falsy）——与 POST /wiki 同语义，两处必须一致，别在一处改成
  // `"parentId" in body` 的口径（AI review #3）。客户端不同送这两个字段。
  const explicitParentId = body.parentId?.trim() ? body.parentId.trim() : null;
  const anchorRequested = !explicitParentId && anchor.anchor === "dramaturgy";
  const changingParent = body.parentId !== undefined || anchorRequested;
  let resolvedParentId = changingParent ? explicitParentId : existing.parentId;
  if (changingParent || body.place !== undefined || body.sortKey !== undefined) {
    if (!anchorRequested) {
      if (!await canPlaceWikiUnder(actor, productionId, resolvedParentId))
        return Response.json({ error: "无权移动到该父文档下" }, { status: 403 });
      if (!await canWriteWikiContainer(actor, productionId, resolvedParentId))
        return Response.json({ error: "无权修改该父文档的子目录" }, { status: 403 });
    }
    // ③ 换父时源父也要可写。锚点支刻意**无条件**判：目标 id 要解析完才知道，比不了
    // "是不是真的换父"。代价是"把一篇已经在灵感库根下的文档再移入一次"这种空操作
    // 也会被源父门 403，fail-closed，别当 bug"修"掉。
    if (anchorRequested || (changingParent && resolvedParentId !== existing.parentId)) {
      if (!await canWriteWikiContainer(actor, productionId, existing.parentId))
        return Response.json({ error: "无权把文档移出原父文档" }, { status: 403 });
    }
    if (anchorRequested) {
      const placed = await gateAndResolveWikiAnchor(actor, productionId, "dramaturgy");
      if (!placed.ok)
        return Response.json({
          error: placed.reason === "place" ? "无权移动到该父文档下" : "无权修改该父文档的子目录",
        }, { status: 403 });
      resolvedParentId = placed.parentId;
    }
  }

  try {
    if (wantsContent) {
      // 协作行级合并在 updateWiki 行锁事务内进行（AI review：路由层读取-合并-写回
      // 无锁会被并发覆盖）；mergeBase=客户端 base，服务端被推进时三路合并
      await updateWiki(wikiId, productionId, {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.body !== undefined && body.baseBody !== undefined ? { mergeBase: body.baseBody } : {}),
        ...(body.mentions !== undefined ? { mentions: body.mentions } : {}),
        ...(changingParent ? { parentId: resolvedParentId } : {}),
        ...(body.sortKey !== undefined ? { sortKey: body.sortKey } : {}),
        ...(body.place !== undefined ? { place: body.place } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      }, session.userId);
    }
    if (body.isPublic !== undefined) await setWikiPublic(wikiId, productionId, body.isPublic);
    if (body.listable !== undefined) await setWikiListable(wikiId, productionId, body.listable);
    const fresh = await getWiki(wikiId, productionId);
    // 协作广播（内容/标题/标签变化才推；标签帧缺省=本帧没动标签）
    if (fresh && (body.body !== undefined || body.title !== undefined || body.tags !== undefined)) {
      broadcastWikiUpdate(wikiId, {
        byClientId: body.clientId ?? null,
        title: fresh.title,
        body: fresh.body,
        updatedAt: fresh.updatedAt,
        ...(body.tags !== undefined ? { tags: fresh.tags } : {}),
      });
    }
    return Response.json({ wiki: fresh });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "更新失败" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, wikiId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  if (!await canDeleteWiki(actor, productionId, wikiId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const result = await deleteWiki(wikiId, productionId);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "文档不存在" }, { status: 404 });
    if (result.reason === "anchor")
      return Response.json({ error: "系统目录文档（报告归档锚点）不可删除，可移动或改名" }, { status: 409 });
    return Response.json(
      { error: "该文档被 report/note 挂载引用，不可直接删除（先解除挂载）" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
