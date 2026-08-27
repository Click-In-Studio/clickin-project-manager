import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { canReachAliasTarget, createWikiAlias, isWikiAliasTargetType } from "@/lib/wiki-alias-db";
import { canPlaceWikiUnder, canWriteWikiContainer } from "@/lib/wiki-perm";
import { ensureDramaturgyRootAnchor } from "@/lib/wiki-db";
import { readParentAnchor, readPlacement, readTrimmedId } from "@/lib/wiki-input";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/production/[id]/wiki-alias   建软链接（#358）
//
// 三道门，全部是**位置**面的门——别名不是文档，没有内容面的门可发：
//   ① wiki/*@create：往文档树里加东西是同一个能力，与 createWiki 同门
//      （否则「无权新建就改为建别名」是条后门）
//   ② 落位双门（#357 症状⑤）：目标父可枚举 ∧ 目标父容器可写
//   ③ 目标可达：能枚举它（在自己树里见过）或能读它（经 wikilink 到达）
//      —— 不能给一个自己完全看不见的 id 建别名。判据挂在**解析器**上而不是这里
//      硬编码 target_type，接新目标类型才是只改解析器一处（AI review #1）。
// 刻意**没有**的门：目标的 edit / share。建别名不改目标一个字节，也不给任何人
// 多一分对目标的权限——每个观看者的可见性都由 wiki_alias 的判定式当场重算。
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const body = await req.json() as Record<string, unknown>;
  const targetId = readTrimmedId(body.targetId);
  const targetType = readTrimmedId(body.targetType) ?? "wiki";
  const displayTitle = typeof body.displayTitle === "string" ? body.displayTitle
    : body.displayTitle === null ? null : undefined;
  if (!targetId) return Response.json({ error: "缺少链接目标" }, { status: 400 });
  if (!isWikiAliasTargetType(targetType))
    return Response.json({ error: "暂不支持这种链接目标" }, { status: 400 });
  const anchor = readParentAnchor(body.parentAnchor);
  if (!anchor.ok) return Response.json({ error: "未知的落位锚点" }, { status: 400 });
  // 锚点落位（#355 移入）：灵感库根尚未懒建时客户端给 parentAnchor 而不是 parentId。
  // ensure 是写事务，留在门后面解析（同 POST /wiki）。两者同送时锚点胜——与
  // PATCH /wiki 同语义，见那边的 AI review #3 注释。
  const explicitParentId = readTrimmedId(body.parentId);
  const anchorRequested = !explicitParentId && anchor.anchor === "dramaturgy";
  const place = readPlacement(body.place);

  if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  // 落位双门只对**显式父**判定；锚点路径两道恒真且可静态论证（根 is_public +
  // listable ⇒ ①，isWikiAnchor ⇒ ②），见 POST /wiki 同段注释。
  if (!anchorRequested) {
    if (!await canPlaceWikiUnder(actor, productionId, explicitParentId))
      return Response.json({ error: "无权在该父文档下创建" }, { status: 403 });
    if (!await canWriteWikiContainer(actor, productionId, explicitParentId))
      return Response.json({ error: "无权修改该父文档的子目录" }, { status: 403 });
  }
  if (!await canReachAliasTarget(actor, productionId, targetType, targetId))
    return Response.json({ error: "目标文档不存在或不可见" }, { status: 403 });

  const parentId = explicitParentId
    ?? (anchorRequested ? await ensureDramaturgyRootAnchor(productionId) : null);

  const res = await createWikiAlias({
    productionId, parentId, targetType, targetId,
    createdBy: session.userId,
    ...(place ? { place } : {}),
    ...(displayTitle !== undefined ? { displayTitle } : {}),
  });
  if (!res.ok) {
    const msg: Record<string, string> = {
      target_not_found: "目标文档不存在",
      parent_not_found: "父文档不存在",
      unsupported_target: "暂不支持这种链接目标",
      inside_target_subtree: "不能把链接建在目标自己的子树里",
      duplicate: "该位置已有指向同一目标的链接",
    };
    return Response.json({ error: msg[res.reason] ?? "创建失败" },
      { status: res.reason === "duplicate" ? 409 : 400 });
  }
  return Response.json({ alias: res.alias }, { status: 201 });
}
