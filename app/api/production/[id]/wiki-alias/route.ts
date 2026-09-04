import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { canReachLinkTarget, createNodeLink, isLinkableTarget } from "@/lib/node/link";
import { getNode, getNodeByWikiId } from "@/lib/node/db";
import { canPlaceNodeUnder, canWriteNodeContainer } from "@/lib/node/perm";
import { gateNodeAnchorPlacement, resolveNodeAnchorParent } from "@/lib/node/placement";
import { readParentAnchor, readPlacement, readTrimmedId } from "@/lib/wiki/input";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/production/[id]/wiki-alias   建软链接（#358 → #420 node 化）
//
// 三道门，全部是**位置**面的门——link 不是内容，没有内容面的门可发：
//   ① wiki/*@create：往树里加东西是同一个能力，与 createWiki 同门
//      （否则「无权新建就改为建链接」是条后门）
//   ② 落位双门（#357 症状⑤）：目标父可枚举 ∧ 目标父容器可写
//   ③ 目标可达：能枚举它 ∨ 能读它——不能给一个自己完全看不见的节点建链接
// 刻意**没有**的门：目标的 edit / share。建链接不改目标一个字节，每个观看者的
// 可见性都由 link 判定式当场重算。
//
// 入参兼容：targetNodeId（node id，首选）或 targetId（wiki uuid，旧客户端）。
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const actor = toActor(session, access.permCtx);

  const body = await req.json() as Record<string, unknown>;
  const targetNodeIdRaw = readTrimmedId(body.targetNodeId);
  const legacyWikiTargetId = readTrimmedId(body.targetId);
  const displayTitle = typeof body.displayTitle === "string" ? body.displayTitle
    : body.displayTitle === null ? null : undefined;
  const anchor = readParentAnchor(body.parentAnchor);
  const explicitParentId = readTrimmedId(body.parentId);
  const place = readPlacement(body.place);

  // ① 能力门在**所有**字段校验之前：授权优先于格式（二轮 AI review #1 姿态）
  if (!await hasEffectiveGrant(actor, productionId, "wiki", "*", "*", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  if (!targetNodeIdRaw && !legacyWikiTargetId)
    return Response.json({ error: "缺少链接目标" }, { status: 400 });
  if (!anchor.ok) return Response.json({ error: "未知的落位锚点" }, { status: 400 });
  const anchorRequested = !explicitParentId && anchor.anchor === "dramaturgy";

  // 目标解析：node id 直取；旧口径 wiki uuid 经壳节点翻译
  const target = targetNodeIdRaw
    ? await getNode(targetNodeIdRaw, productionId)
    : await getNodeByWikiId(legacyWikiTargetId!);
  if (!target || target.productionId !== productionId)
    return Response.json({ error: "目标不存在或不可见" }, { status: 403 });
  if (!isLinkableTarget(target))
    return Response.json({ error: "暂不支持这种链接目标" }, { status: 400 });

  // ② 落位双门。两支同一顺位（三轮 AI review #2）
  if (anchorRequested) {
    const gate = await gateNodeAnchorPlacement(actor, productionId, "dramaturgy");
    if (!gate.ok)
      return Response.json({
        error: gate.reason === "place" ? "无权在该父节点下创建" : "无权修改该父节点的子目录",
      }, { status: 403 });
  } else {
    if (!await canPlaceNodeUnder(actor, productionId, explicitParentId))
      return Response.json({ error: "无权在该父节点下创建" }, { status: 403 });
    if (!await canWriteNodeContainer(actor, productionId, explicitParentId))
      return Response.json({ error: "无权修改该父节点的子目录" }, { status: 403 });
  }
  // ③ 目标可达
  if (!await canReachLinkTarget(actor, productionId, target))
    return Response.json({ error: "目标不存在或不可见" }, { status: 403 });

  // 解析（可能懒建根）排在所有门之后
  const parentId = anchorRequested
    ? await resolveNodeAnchorParent(productionId, "dramaturgy")
    : explicitParentId;

  const res = await createNodeLink({
    productionId, parentId, targetNodeId: target.id,
    createdBy: session.userId,
    ...(place ? { place } : {}),
    ...(displayTitle !== undefined ? { displayTitle } : {}),
  });
  if (!res.ok) {
    const msg: Record<string, string> = {
      target_not_found: "目标不存在",
      parent_not_found: "父节点不存在",
      unsupported_target: "暂不支持这种链接目标",
      inside_target_subtree: "不能把链接建在目标自己的子树里",
      duplicate: "该位置已有指向同一目标的链接",
    };
    return Response.json({ error: msg[res.reason] ?? "创建失败" },
      { status: res.reason === "duplicate" ? 409 : 400 });
  }
  return Response.json({ alias: res.link }, { status: 201 });
}
